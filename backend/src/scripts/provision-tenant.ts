// CLI entry point for tenant provisioning.
//
// Usage:
//   npm run tenant:provision -- --name "Nakuru Hardware" --subdomain nakuru-hardware \
//     [--sector retail] [--kra-pin A123456789Z] [--tier MWANZO]
//
// Provisioning itself is idempotent: re-running with the same subdomain reports
// created:false and applies zero migrations.

import { closePool } from "../db/pool";
import { disconnectAllTenantDbs } from "../db/tenant";
import {
  provisionTenant,
  type ProvisionTenantInput,
} from "../services/tenant-provisioning";
import { SubscriptionTier } from "../generated/platform/enums";

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(key, "");
    } else {
      flags.set(key, next);
      i += 1;
    }
  }
  return flags;
}

function requireFlag(flags: Map<string, string>, key: string): string {
  const value = flags.get(key);
  if (value === undefined || value === "") {
    throw new Error(`Missing required flag --${key}`);
  }
  return value;
}

function parseSubscriptionTier(raw: string): SubscriptionTier {
  const valid = Object.values(SubscriptionTier);
  if ((valid as string[]).includes(raw)) {
    return raw as SubscriptionTier;
  }
  throw new Error(
    `Invalid --tier "${raw}". Expected one of: ${valid.join(", ")}.`,
  );
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));

  const input: ProvisionTenantInput = {
    name: requireFlag(flags, "name"),
    subdomain: requireFlag(flags, "subdomain"),
  };

  const sector = flags.get("sector");
  if (sector !== undefined && sector !== "") {
    input.businessSector = sector;
  }
  const kraPin = flags.get("kra-pin");
  if (kraPin !== undefined && kraPin !== "") {
    input.kraPin = kraPin;
  }
  const tier = flags.get("tier");
  if (tier !== undefined && tier !== "") {
    input.subscriptionTier = parseSubscriptionTier(tier);
  }

  const result = await provisionTenant(input);

  console.log("Tenant provisioned:");
  console.log(`  tenantId:          ${result.tenantId}`);
  console.log(`  schema:            ${result.schema}`);
  console.log(`  created:           ${result.created}`);
  console.log(
    `  migrationsApplied: ${result.migrationsApplied.length > 0 ? result.migrationsApplied.join(", ") : "(none)"}`,
  );
  console.log(`  accountsSeeded:    ${result.accountsSeeded}`);
  console.log(`  statutorySeeded:   ${result.statutorySchedulesSeeded}`);
  console.log(`  locationsSeeded:   ${result.locationsSeeded}`);
}

main()
  .then(async () => {
    await disconnectAllTenantDbs();
    await closePool();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Provisioning failed: ${message}`);
    await disconnectAllTenantDbs().catch((e: unknown) => {
      console.error("Cleanup: failed to disconnect tenant clients:", e);
    });
    await closePool().catch((e: unknown) => {
      console.error("Cleanup: failed to close pool:", e);
    });
    process.exit(1);
  });
