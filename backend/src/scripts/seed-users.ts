// Seeds the platform user registry with development accounts. Idempotent:
// upserts by email, so re-running updates rather than duplicates.
//
// Usage: npm run seed:users
//
// The seed password comes from SEED_USER_PASSWORD only (src/scripts/seed-password.ts): there is no
// committed default, the seed refuses to run without it, and the value is never logged.

import { platformDb } from "../db/platform";
import { closePool } from "../db/pool";
import { assertPasswordPolicy, hashPassword } from "../auth/password";
import { revokeAllUserSessions } from "../auth/tokens";
import type { UserRole } from "../generated/platform/enums";
import { resolveSeedPassword } from "./seed-password";

interface SeedUser {
  email: string;
  fullName: string;
  role: UserRole;
  tenantSubdomain: string | null;
}

const SEED_USERS: SeedUser[] = [
  {
    email: "admin@angazafuture.org",
    fullName: "Angaza Platform Admin",
    role: "SUPER_ADMIN",
    tenantSubdomain: null,
  },
  // Module 14 (Task 14.1): platform-level mentors — NO tenant. They read a mentee
  // business only through an ACTIVE, consented engagement (see mentorship/access.ts).
  {
    email: "mentor@angazafuture.org",
    fullName: "Angaza Business Mentor",
    role: "MENTOR",
    tenantSubdomain: null,
  },
  {
    email: "coach@angazafuture.org",
    fullName: "Angaza Business Coach",
    role: "COACH",
    tenantSubdomain: null,
  },
  {
    email: "owner@nakuru-hardware.co.ke",
    fullName: "Nakuru Hardware Owner",
    role: "MSME_OWNER",
    tenantSubdomain: "nakuru-hardware",
  },
  {
    email: "cashier@nakuru-hardware.co.ke",
    fullName: "Nakuru Hardware Cashier",
    role: "CASHIER",
    tenantSubdomain: "nakuru-hardware",
  },
  {
    email: "owner@thika-agrovet.co.ke",
    fullName: "Thika Agrovet Owner",
    role: "MSME_OWNER",
    tenantSubdomain: "thika-agrovet",
  },
];

async function resolveTenantId(subdomain: string): Promise<string> {
  const tenant = await platformDb.tenant.findUnique({
    where: { subdomain },
    select: { id: true },
  });
  if (tenant === null) {
    throw new Error(
      `Cannot seed users for tenant "${subdomain}": no such tenant in public.tenants. Provision it first (npm run tenant:provision).`,
    );
  }
  return tenant.id;
}

async function main(): Promise<void> {
  const password = resolveSeedPassword(process.env);
  assertPasswordPolicy(password);
  const passwordHash = await hashPassword(password);

  const summary: Array<{ email: string; role: UserRole; tenant: string; action: string }> = [];

  for (const seed of SEED_USERS) {
    const tenantId =
      seed.tenantSubdomain === null ? null : await resolveTenantId(seed.tenantSubdomain);

    const existing = await platformDb.user.findUnique({
      where: { email: seed.email },
      select: { id: true },
    });

    await platformDb.user.upsert({
      where: { email: seed.email },
      update: {
        fullName: seed.fullName,
        role: seed.role,
        tenantId,
        passwordHash,
        passwordUpdatedAt: new Date(),
        isActive: true,
        // M4.5 W1: a seeded password is a SHARED secret — the account must replace it at
        // its first sign-in before any access.
        mustResetPassword: true,
      },
      create: {
        email: seed.email,
        fullName: seed.fullName,
        role: seed.role,
        tenantId,
        passwordHash,
        passwordUpdatedAt: new Date(),
        isActive: true,
        mustResetPassword: true,
      },
    });
    // A re-seed resets the password, so any session opened with the old one ends.
    if (existing !== null) {
      await revokeAllUserSessions(existing.id);
    }

    summary.push({
      email: seed.email,
      role: seed.role,
      tenant: seed.tenantSubdomain ?? "(platform)",
      action: existing === null ? "created" : "updated",
    });
  }

  console.log("\nSeeded users:");
  console.table(summary);
}

main()
  .then(async () => {
    await platformDb.$disconnect();
    await closePool();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Seeding failed: ${message}`);
    await platformDb.$disconnect().catch((e: unknown) => {
      console.error("Cleanup: failed to disconnect platform client:", e);
    });
    await closePool().catch((e: unknown) => {
      console.error("Cleanup: failed to close pool:", e);
    });
    process.exit(1);
  });
