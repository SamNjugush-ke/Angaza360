// ===========================================================================
// The onboarding GREEN-GATE (Task T-A6.1; reused by T-A6.2 self-serve and T-A6.3 batch).
//
// validateOnboardingCandidate(candidate) answers ONE question for every onboarding
// path — single admin entry, public signup, approval, batch preview and batch commit:
// may this business be onboarded as it stands? It returns GREEN, or RED with a list of
// field errors. NOTHING IS PROVISIONED AND NO ONE IS INVITED FOR A CANDIDATE THAT IS NOT
// GREEN, single or batch.
//
// THE DEDUP RULES (the product owner's):
//   * the business NAME is unique, case-insensitively — "pick another";
//   * the business KRA PIN, when given, is unique;
//   * the owner's National ID, when given, is unique;
//   * the SUBDOMAIN is unique (and valid, and not reserved);
//   * and, so the owner invitation cannot fail after provisioning, the owner's EMAIL is
//     not already a user or an open invitation.
// "Unique" is checked against existing tenants (and users / open invitations for the
// owner's identity), against every OPEN tenant application (Task T-A6.2) other than the one
// being checked, and against the caller's SIBLINGS — the other rows of the same batch
// upload. The database holds the tenant-name, KRA PIN and National ID rules too (unique
// indexes, platform migration 20261019100000), so a race past this check still fails.
//
// Formats: KRA PIN is a letter, nine digits, a letter (A123456789Z); a National ID is 6–10
// digits; a phone is 9–15 digits with an optional leading +.
// ===========================================================================

import { platformDb } from "../../db/platform";
import { isValidSubdomain, RESERVED_SUBDOMAINS } from "../../db/tenant";
import type { Prisma } from "../../generated/platform/client";
import type { SubscriptionTier } from "../../generated/platform/enums";
import type { TenantTaxRegime } from "../../generated/tenant/enums";
import { generateUniqueSubdomain, isSubdomainTaken, openApplicationsWhere, type SubdomainScope } from "./subdomain";

export const TENANT_TAX_REGIMES: readonly TenantTaxRegime[] = ["VAT_REGISTERED", "TURNOVER_TAX", "EXEMPT"];
export const SUBSCRIPTION_TIERS: readonly SubscriptionTier[] = ["MWANZO", "UKUAJI", "BIASHARA", "MSTAWI", "ENTERPRISE"];

/** What an onboarding path supplies. Optional fields may be absent or null. */
export interface OnboardingCandidate {
  readonly businessName: string;
  readonly subdomain?: string | null;
  readonly sector?: string | null;
  readonly kraPin?: string | null;
  /** The regime the business declares — BusinessProfile's vocabulary. */
  readonly taxRegime: string;
  readonly requestedTier?: string | null;
  readonly ownerFullName: string;
  readonly ownerEmail: string;
  readonly ownerPhone?: string | null;
  readonly ownerNationalId?: string | null;
}

/** The candidate after trimming and case normalisation — what is stored and compared. */
export interface NormalizedCandidate {
  readonly businessName: string;
  readonly subdomain: string | null;
  readonly sector: string | null;
  readonly kraPin: string | null;
  readonly taxRegime: string;
  readonly requestedTier: string | null;
  readonly ownerFullName: string;
  readonly ownerEmail: string;
  readonly ownerPhone: string | null;
  readonly ownerNationalId: string | null;
}

export type CandidateField = keyof OnboardingCandidate;

export interface CandidateError {
  readonly field: CandidateField;
  readonly code: "REQUIRED" | "FORMAT" | "DUPLICATE" | "RESERVED";
  readonly message: string;
}

export interface CandidateValidation {
  readonly status: "GREEN" | "RED";
  readonly errors: readonly CandidateError[];
  /** The subdomain this candidate would get: the one supplied, or a generated free one. */
  readonly proposedSubdomain: string | null;
  readonly normalized: NormalizedCandidate;
}

export interface ValidationScope {
  /** Other rows of the same batch, already normalised. */
  readonly siblings?: readonly NormalizedCandidate[];
  /** The proposed subdomains of those siblings. */
  readonly siblingSubdomains?: ReadonlySet<string>;
  /** The application being (re-)validated: it never clashes with itself. */
  readonly excludeApplicationId?: string;
  /** Its batch: those rows are compared as siblings, not as open applications. */
  readonly excludeBatchId?: string;
}

function subdomainScope(scope: ValidationScope): SubdomainScope {
  return {
    ...(scope.siblingSubdomains !== undefined ? { alsoTaken: scope.siblingSubdomains } : {}),
    ...(scope.excludeApplicationId !== undefined ? { excludeApplicationId: scope.excludeApplicationId } : {}),
    ...(scope.excludeBatchId !== undefined ? { excludeBatchId: scope.excludeBatchId } : {}),
  };
}

const KRA_PIN = /^[AP][0-9]{9}[A-Z]$/;
const NATIONAL_ID = /^[0-9]{6,10}$/;
const PHONE = /^\+?[0-9]{9,15}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function normalizeCandidate(candidate: OnboardingCandidate): NormalizedCandidate {
  return {
    businessName: (clean(candidate.businessName) ?? "").replace(/\s+/g, " "),
    subdomain: clean(candidate.subdomain)?.toLowerCase() ?? null,
    sector: clean(candidate.sector),
    kraPin: clean(candidate.kraPin)?.toUpperCase() ?? null,
    taxRegime: clean(candidate.taxRegime)?.toUpperCase() ?? "",
    requestedTier: clean(candidate.requestedTier)?.toUpperCase() ?? null,
    ownerFullName: clean(candidate.ownerFullName) ?? "",
    ownerEmail: clean(candidate.ownerEmail)?.toLowerCase() ?? "",
    ownerPhone: clean(candidate.ownerPhone)?.replace(/[\s-]/g, "") ?? null,
    ownerNationalId: clean(candidate.ownerNationalId)?.replace(/\s/g, "") ?? null,
  };
}

function formatErrors(c: NormalizedCandidate): CandidateError[] {
  const errors: CandidateError[] = [];
  if (c.businessName.length < 2 || c.businessName.length > 200) {
    errors.push({ field: "businessName", code: c.businessName === "" ? "REQUIRED" : "FORMAT", message: "A business name of 2–200 characters is required." });
  }
  if (c.ownerFullName === "" || c.ownerFullName.length > 200) {
    errors.push({ field: "ownerFullName", code: c.ownerFullName === "" ? "REQUIRED" : "FORMAT", message: "The owner's full name is required (at most 200 characters)." });
  }
  if (c.ownerEmail === "" || !EMAIL.test(c.ownerEmail) || c.ownerEmail.length > 320) {
    errors.push({ field: "ownerEmail", code: c.ownerEmail === "" ? "REQUIRED" : "FORMAT", message: "A valid owner email is required." });
  }
  if (!(TENANT_TAX_REGIMES as readonly string[]).includes(c.taxRegime)) {
    errors.push({ field: "taxRegime", code: c.taxRegime === "" ? "REQUIRED" : "FORMAT", message: `taxRegime must be one of ${TENANT_TAX_REGIMES.join(", ")}.` });
  }
  if (c.requestedTier !== null && !(SUBSCRIPTION_TIERS as readonly string[]).includes(c.requestedTier)) {
    errors.push({ field: "requestedTier", code: "FORMAT", message: `requestedTier must be one of ${SUBSCRIPTION_TIERS.join(", ")}.` });
  }
  if (c.kraPin !== null && !KRA_PIN.test(c.kraPin)) {
    errors.push({ field: "kraPin", code: "FORMAT", message: "A KRA PIN is a letter, nine digits and a letter, e.g. P051234567X." });
  }
  if (c.ownerNationalId !== null && !NATIONAL_ID.test(c.ownerNationalId)) {
    errors.push({ field: "ownerNationalId", code: "FORMAT", message: "A National ID is 6–10 digits." });
  }
  if (c.ownerPhone !== null && !PHONE.test(c.ownerPhone)) {
    errors.push({ field: "ownerPhone", code: "FORMAT", message: "A phone number is 9–15 digits, optionally with a leading +." });
  }
  if (c.subdomain !== null) {
    if (RESERVED_SUBDOMAINS.has(c.subdomain)) {
      errors.push({ field: "subdomain", code: "RESERVED", message: `The subdomain "${c.subdomain}" is reserved. Pick another.` });
    } else if (!isValidSubdomain(c.subdomain)) {
      errors.push({ field: "subdomain", code: "FORMAT", message: "A subdomain is 3–42 lowercase letters, digits and internal hyphens." });
    }
  }
  return errors;
}

const lower = (value: string): string => value.toLowerCase();

async function duplicateErrors(c: NormalizedCandidate, scope: ValidationScope): Promise<CandidateError[]> {
  const errors: CandidateError[] = [];
  const siblings = scope.siblings ?? [];
  const openApps = openApplicationsWhere(scope);
  const appHas = async (where: Prisma.TenantApplicationWhereInput): Promise<boolean> =>
    (await platformDb.tenantApplication.count({ where: { ...openApps, ...where } })) > 0;

  const nameTaken =
    (await platformDb.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM public."tenants" WHERE lower("name") = ${lower(c.businessName)}`)[0]?.n ?? 0;
  if (
    nameTaken > 0 ||
    (await appHas({ businessName: { equals: c.businessName, mode: "insensitive" } })) ||
    siblings.some((s) => lower(s.businessName) === lower(c.businessName))
  ) {
    errors.push({ field: "businessName", code: "DUPLICATE", message: "That business name is already registered. Pick another." });
  }

  if (c.kraPin !== null) {
    const taken =
      (await platformDb.tenant.count({ where: { kraPin: c.kraPin } })) > 0 ||
      (await appHas({ kraPin: c.kraPin })) ||
      siblings.some((s) => s.kraPin === c.kraPin);
    if (taken) errors.push({ field: "kraPin", code: "DUPLICATE", message: "That KRA PIN is already registered." });
  }

  if (c.ownerNationalId !== null) {
    const taken =
      (await platformDb.user.count({ where: { nationalId: c.ownerNationalId } })) > 0 ||
      (await platformDb.userInvitation.count({ where: { nationalId: c.ownerNationalId, status: "PENDING" } })) > 0 ||
      (await appHas({ ownerNationalId: c.ownerNationalId })) ||
      siblings.some((s) => s.ownerNationalId === c.ownerNationalId);
    if (taken) errors.push({ field: "ownerNationalId", code: "DUPLICATE", message: "That National ID is already registered." });
  }

  if (c.ownerEmail !== "") {
    const taken =
      (await platformDb.user.count({ where: { email: c.ownerEmail } })) > 0 ||
      (await platformDb.userInvitation.count({ where: { email: c.ownerEmail, status: "PENDING" } })) > 0 ||
      (await appHas({ ownerEmail: c.ownerEmail })) ||
      siblings.some((s) => s.ownerEmail === c.ownerEmail);
    if (taken) errors.push({ field: "ownerEmail", code: "DUPLICATE", message: "That email already has an account or an open invitation." });
  }

  if (c.subdomain !== null && isValidSubdomain(c.subdomain)) {
    if (await isSubdomainTaken(c.subdomain, subdomainScope(scope))) {
      errors.push({ field: "subdomain", code: "DUPLICATE", message: `The subdomain "${c.subdomain}" is taken. Pick another.` });
    }
  }
  return errors;
}

/** GREEN, or RED with every field error. Reads only — writes nothing. */
export async function validateOnboardingCandidate(
  candidate: OnboardingCandidate,
  scope: ValidationScope = {},
): Promise<CandidateValidation> {
  const normalized = normalizeCandidate(candidate);
  const errors = [...formatErrors(normalized), ...(await duplicateErrors(normalized, scope))];
  let proposedSubdomain: string | null = null;
  if (normalized.subdomain !== null) {
    proposedSubdomain = normalized.subdomain;
  } else if (normalized.businessName !== "") {
    proposedSubdomain = await generateUniqueSubdomain(normalized.businessName, subdomainScope(scope));
  }
  return { status: errors.length === 0 ? "GREEN" : "RED", errors, proposedSubdomain, normalized };
}
