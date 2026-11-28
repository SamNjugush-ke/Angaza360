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
//
// THE COMPREHENSIVE APPLICATION (M4.5 Wave 2) adds the business's structure, registration and
// contact details and its county. TWO KRA PINS: `kraPin` is the OWNER's personal PIN and
// `businessKraPin` the business's own (a partnership's or company's); a sole proprietor's
// business PIN IS the owner's. The business's EFFECTIVE PIN — the one on the registry, its
// receipts and the dedup rule — is `businessKraPin ?? kraPin`. With `comprehensive: true` (the
// public form) the structure, physical address, county and owner National ID are required, a
// partnership or company needs its own PIN, and a limited company its registration number.
// ===========================================================================

import { platformDb } from "../../db/platform";
import { isValidSubdomain, RESERVED_SUBDOMAINS } from "../../db/tenant";
import type { Prisma } from "../../generated/platform/client";
import type { SubscriptionTier } from "../../generated/platform/enums";
import type { TenantTaxRegime } from "../../generated/tenant/enums";
import { canonicalCounty } from "../../lib/kenya-counties";
import { normalizePhone } from "../../lib/phone";
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
  // M4.5 Wave 2 — the comprehensive application.
  readonly businessStructure?: string | null;
  readonly registrationNumber?: string | null;
  readonly businessKraPin?: string | null;
  readonly description?: string | null;
  readonly physicalAddress?: string | null;
  readonly county?: string | null;
  readonly permitNumber?: string | null;
  readonly businessPhone?: string | null;
  readonly businessEmail?: string | null;
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
  readonly businessStructure: string | null;
  readonly registrationNumber: string | null;
  readonly businessKraPin: string | null;
  readonly description: string | null;
  readonly physicalAddress: string | null;
  readonly county: string | null;
  readonly permitNumber: string | null;
  readonly businessPhone: string | null;
  readonly businessEmail: string | null;
}

export const BUSINESS_STRUCTURES = ["SOLE_PROPRIETOR", "PARTNERSHIP", "LIMITED_COMPANY"] as const;

/** The business's own KRA PIN as the registry holds it: its own, or (sole proprietor) the owner's. */
export function effectiveKraPin(c: Pick<NormalizedCandidate, "kraPin" | "businessKraPin">): string | null {
  return c.businessKraPin ?? c.kraPin;
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
  /** The comprehensive public form (M4.5 W2): its required fields are required. */
  readonly comprehensive?: boolean;
  /**
   * The owner's phone is REQUIRED and is judged (and normalised) by the shared normaliser
   * (src/lib/phone.ts): the self-serve application, its edits and submission, and batch rows.
   * Not set on the admin single-create or staff review paths, which judge it as before.
   */
  readonly ownerPhoneRequired?: boolean;
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
    businessStructure: clean(candidate.businessStructure)?.toUpperCase() ?? null,
    registrationNumber: clean(candidate.registrationNumber)?.toUpperCase().replace(/\s+/g, "") ?? null,
    businessKraPin: clean(candidate.businessKraPin)?.toUpperCase() ?? null,
    description: clean(candidate.description),
    physicalAddress: clean(candidate.physicalAddress)?.replace(/\s+/g, " ") ?? null,
    county: (() => {
      const raw = clean(candidate.county);
      return raw === null ? null : (canonicalCounty(raw) ?? raw);
    })(),
    permitNumber: clean(candidate.permitNumber),
    businessPhone: clean(candidate.businessPhone)?.replace(/[\s-]/g, "") ?? null,
    businessEmail: clean(candidate.businessEmail)?.toLowerCase() ?? null,
  };
}

function formatErrors(c: NormalizedCandidate, comprehensive: boolean): CandidateError[] {
  const errors: CandidateError[] = [];
  if (c.businessStructure !== null && !(BUSINESS_STRUCTURES as readonly string[]).includes(c.businessStructure)) {
    errors.push({ field: "businessStructure", code: "FORMAT", message: `The business structure is one of ${BUSINESS_STRUCTURES.join(", ")}.` });
  }
  if (c.businessKraPin !== null && !KRA_PIN.test(c.businessKraPin)) {
    errors.push({ field: "businessKraPin", code: "FORMAT", message: "A KRA PIN is a letter, nine digits and a letter, e.g. P051234567X." });
  }
  if (c.county !== null && canonicalCounty(c.county) === null) {
    errors.push({ field: "county", code: "FORMAT", message: "Choose one of Kenya's 47 counties." });
  }
  if (c.businessPhone !== null && !PHONE.test(c.businessPhone)) {
    errors.push({ field: "businessPhone", code: "FORMAT", message: "A phone number is 9–15 digits, optionally with a leading +." });
  }
  if (c.businessEmail !== null && (!EMAIL.test(c.businessEmail) || c.businessEmail.length > 320)) {
    errors.push({ field: "businessEmail", code: "FORMAT", message: "Enter a valid business email address." });
  }
  for (const [field, value, max] of [
    ["registrationNumber", c.registrationNumber, 60],
    ["description", c.description, 1000],
    ["physicalAddress", c.physicalAddress, 300],
    ["permitNumber", c.permitNumber, 60],
  ] as const) {
    if (value !== null && value.length > max) {
      errors.push({ field, code: "FORMAT", message: `At most ${max.toString()} characters.` });
    }
  }
  if (comprehensive) {
    if (c.businessStructure === null) {
      errors.push({ field: "businessStructure", code: "REQUIRED", message: "Choose how the business is structured." });
    }
    if (c.physicalAddress === null) {
      errors.push({ field: "physicalAddress", code: "REQUIRED", message: "Where the business operates is required." });
    }
    if (c.county === null) {
      errors.push({ field: "county", code: "REQUIRED", message: "The county the business operates in is required." });
    }
    if (c.ownerNationalId === null) {
      errors.push({ field: "ownerNationalId", code: "REQUIRED", message: "The owner's National ID number is required to verify the application." });
    }
    if ((c.businessStructure === "PARTNERSHIP" || c.businessStructure === "LIMITED_COMPANY") && c.businessKraPin === null) {
      errors.push({ field: "businessKraPin", code: "REQUIRED", message: "A partnership or company has its own KRA PIN — enter it." });
    }
    if (c.businessStructure === "LIMITED_COMPANY" && c.registrationNumber === null) {
      errors.push({ field: "registrationNumber", code: "REQUIRED", message: "A limited company's registration number (e.g. PVT-ABC123) is required." });
    }
  }
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

export const OWNER_PHONE_REQUIRED_MESSAGE = "A valid owner phone is required.";

/**
 * The owner's phone as it should be stored: canonical E.164 when the shared normaliser reads it,
 * otherwise the compacted text as typed (the row stays correctable, and the check names it).
 */
export function canonicalOwnerPhone(phone: string | null): string | null {
  const result = normalizePhone(phone);
  return result.ok ? result.e164 : phone;
}

/** Where the owner's phone is required: present, and a valid number by the shared normaliser. */
function ownerPhoneErrors(c: NormalizedCandidate, scope: ValidationScope): CandidateError[] {
  if (scope.ownerPhoneRequired !== true) return [];
  const result = normalizePhone(c.ownerPhone);
  if (result.ok) return [];
  return [
    result.reason === "MISSING"
      ? { field: "ownerPhone", code: "REQUIRED", message: `${OWNER_PHONE_REQUIRED_MESSAGE} Add the owner's mobile number, e.g. 0712 345 678.` }
      : { field: "ownerPhone", code: "FORMAT", message: `${OWNER_PHONE_REQUIRED_MESSAGE} "${c.ownerPhone ?? ""}" is not a valid phone number; use e.g. 0712 345 678, or +<country code> for another country.` },
  ];
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

  // The business's EFFECTIVE PIN (its own, or a sole proprietor's) is unique among businesses.
  const pin = effectiveKraPin(c);
  if (pin !== null) {
    const taken =
      (await platformDb.tenant.count({ where: { kraPin: pin } })) > 0 ||
      (await appHas({ OR: [{ businessKraPin: pin }, { businessKraPin: null, kraPin: pin }] })) ||
      siblings.some((s) => effectiveKraPin(s) === pin);
    if (taken) errors.push({ field: c.businessKraPin !== null ? "businessKraPin" : "kraPin", code: "DUPLICATE", message: "That KRA PIN is already registered." });
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
  const base = normalizeCandidate(candidate);
  const phoneRequired = scope.ownerPhoneRequired === true;
  const normalized: NormalizedCandidate = phoneRequired ? { ...base, ownerPhone: canonicalOwnerPhone(base.ownerPhone) } : base;
  // The required-phone rule replaces the generic phone format check rather than doubling it.
  const format = formatErrors(normalized, scope.comprehensive === true).filter((e) => !(phoneRequired && e.field === "ownerPhone"));
  const errors = [...format, ...ownerPhoneErrors(normalized, scope), ...(await duplicateErrors(normalized, scope))];
  let proposedSubdomain: string | null = null;
  if (normalized.subdomain !== null) {
    proposedSubdomain = normalized.subdomain;
  } else if (normalized.businessName !== "") {
    proposedSubdomain = await generateUniqueSubdomain(normalized.businessName, subdomainScope(scope));
  }
  return { status: errors.length === 0 ? "GREEN" : "RED", errors, proposedSubdomain, normalized };
}
