// ===========================================================================
// Tenant subdomains for onboarding (Task T-A6.1; reused by T-A6.2 / T-A6.3).
//
// generateUniqueSubdomain(name) turns a business name into a subdomain that satisfies
// SUBDOMAIN_PATTERN (src/db/tenant.ts — the same rule provisioning asserts), is not
// RESERVED, and is not already held. A collision gets a numeric suffix: -2, -3, … .
// "Held" means held by an existing tenant, proposed by an OPEN tenant application
// (Task T-A6.2), or — within one batch upload — claimed by a sibling row, which the caller
// passes in.
// ===========================================================================

import { platformDb } from "../../db/platform";
import type { Prisma } from "../../generated/platform/client";
import { isValidSubdomain, RESERVED_SUBDOMAINS, SUBDOMAIN_MAX_LENGTH } from "../../db/tenant";

const MIN_STEM_LENGTH = 3;
const MAX_SUFFIX = 9_999;
const FALLBACK_STEM = "business";

/** A business name as a subdomain stem: lowercase ASCII alphanumerics and single hyphens. */
export function slugifySubdomain(name: string): string {
  const ascii = name.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  let stem = ascii
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (stem === "") {
    stem = FALLBACK_STEM;
  }
  if (stem.length < MIN_STEM_LENGTH) {
    stem = `${stem}-biz`;
  }
  return stem.slice(0, SUBDOMAIN_MAX_LENGTH).replace(/-+$/g, "");
}

export interface SubdomainScope {
  /** Subdomains already claimed by sibling rows in the same batch. */
  readonly alsoTaken?: ReadonlySet<string>;
  /** The application being checked: its own proposal does not count against it. */
  readonly excludeApplicationId?: string;
  /** Its batch: sibling rows are compared through `alsoTaken` instead. */
  readonly excludeBatchId?: string;
}

/** Open (PENDING_APPROVAL) applications, minus the caller's own row and batch. */
export function openApplicationsWhere(scope: { excludeApplicationId?: string; excludeBatchId?: string }): Prisma.TenantApplicationWhereInput {
  return {
    status: "PENDING_APPROVAL",
    ...(scope.excludeApplicationId !== undefined ? { id: { not: scope.excludeApplicationId } } : {}),
    ...(scope.excludeBatchId !== undefined ? { OR: [{ batchId: null }, { batchId: { not: scope.excludeBatchId } }] } : {}),
  };
}

/** Whether a subdomain is reserved, held by a tenant or an open application, or claimed by a sibling. */
export async function isSubdomainTaken(subdomain: string, scope: SubdomainScope = {}): Promise<boolean> {
  if (RESERVED_SUBDOMAINS.has(subdomain) || scope.alsoTaken?.has(subdomain) === true) {
    return true;
  }
  if ((await platformDb.tenant.count({ where: { subdomain } })) > 0) {
    return true;
  }
  return (await platformDb.tenantApplication.count({ where: { ...openApplicationsWhere(scope), proposedSubdomain: subdomain } })) > 0;
}

function withSuffix(stem: string, n: number): string {
  const suffix = `-${n.toString()}`;
  return `${stem.slice(0, SUBDOMAIN_MAX_LENGTH - suffix.length).replace(/-+$/g, "")}${suffix}`;
}

/** The first free, valid subdomain for a business name: the stem, then stem-2, stem-3, … */
export async function generateUniqueSubdomain(name: string, scope: SubdomainScope = {}): Promise<string> {
  const stem = slugifySubdomain(name);
  if (isValidSubdomain(stem) && !(await isSubdomainTaken(stem, scope))) {
    return stem;
  }
  for (let n = 2; n <= MAX_SUFFIX; n += 1) {
    const candidate = withSuffix(stem, n);
    if (isValidSubdomain(candidate) && !(await isSubdomainTaken(candidate, scope))) {
      return candidate;
    }
  }
  throw new Error(`No free subdomain for "${stem}" within ${MAX_SUFFIX.toString()} suffixes.`);
}
