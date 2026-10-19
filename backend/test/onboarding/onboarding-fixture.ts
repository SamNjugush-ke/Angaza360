// ===========================================================================
// Onboarding fixtures (Task T-A6): platform staff, a fresh GREEN candidate, and the
// bookkeeping to drop every tenant a test provisions (users and invitations cascade with
// the tenant; audit rows stay by design).
// ===========================================================================

import { randomInt, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { platformDb } from "../../src/db/platform";
import { dropTenant } from "../setup/tenant";
import { createStaffUser, signIn, type SignedIn, type StaffUser } from "../identity/staff-fixture";

export interface Candidate {
  businessName: string;
  subdomain?: string | null;
  sector?: string | null;
  kraPin?: string | null;
  taxRegime: string;
  requestedTier?: string | null;
  ownerFullName: string;
  ownerEmail: string;
  ownerPhone?: string | null;
  ownerNationalId?: string | null;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function freshKraPin(): string {
  const digits = Array.from({ length: 9 }, () => randomInt(0, 10).toString()).join("");
  return `P${digits}${LETTERS[randomInt(0, 26)] ?? "X"}`;
}

export function freshNationalId(): string {
  return randomInt(10_000_000, 99_999_999).toString();
}

export function freshCandidate(overrides: Partial<Candidate> = {}): Candidate {
  const tag = randomUUID().slice(0, 8);
  return {
    businessName: `QA Onboarded ${tag}`,
    sector: "Retail",
    kraPin: freshKraPin(),
    taxRegime: "VAT_REGISTERED",
    requestedTier: "UKUAJI",
    ownerFullName: `QA Owner ${tag}`,
    ownerEmail: `qa-owner-${tag}@test.invalid`,
    ownerPhone: `+2547${randomInt(10_000_000, 99_999_999).toString()}`,
    ownerNationalId: freshNationalId(),
    ...overrides,
  };
}

export interface PlatformStaff {
  readonly superAdmin: SignedIn;
  readonly officer: SignedIn;
  readonly users: readonly StaffUser[];
}

export async function platformStaff(app: FastifyInstance): Promise<PlatformStaff> {
  const admin = await createStaffUser("SUPER_ADMIN", null);
  const officer = await createStaffUser("PROGRAM_OFFICER", null);
  return { superAdmin: await signIn(app, admin), officer: await signIn(app, officer), users: [admin, officer] };
}

/** Drops every tenant whose name a test registered, then the platform users. */
export async function cleanUp(subdomains: readonly string[], users: readonly StaffUser[]): Promise<void> {
  for (const subdomain of subdomains) {
    await dropTenant(subdomain);
  }
  await platformDb.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
}
