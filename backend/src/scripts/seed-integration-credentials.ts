// Seeds each ACTIVE tenant's M-Pesa and KRA eTIMS SANDBOX credentials into their
// own encrypted credential store, activates them, and turns each integration on
// pointing at SANDBOX (Tasks 3.4 and 4.1).
//
// Usage: npm run seed:credentials
//
// This is what makes the 3.4 retrofit live for tenants that already existed:
// before it, M-Pesa read process-wide env credentials; after it, every tenant
// resolves its OWN shortcode from its OWN schema. Idempotent — putCredential
// upserts by (provider, environment), so re-running rotates the blob to the same
// values and re-activates; it never duplicates a row.
//
// DEVELOPMENT VALUES. The defaults below are obviously-fake sandbox strings, not
// real Daraja or KRA credentials, and each tenant deliberately gets a DIFFERENT
// shortcode and a DIFFERENT KRA PIN so per-tenant resolution is observable — two
// tenants sharing either would make a cross-tenant leak invisible. Real
// credentials are entered by the shop owner through
// PUT /v1/integrations/<PROVIDER>/credentials and are never committed to this
// repository. Override per tenant with environment variables:
//   SEED_MPESA_<SLUG>_SHORTCODE / _CONSUMER_KEY / _CONSUMER_SECRET / _PASSKEY
//   SEED_ETIMS_<SLUG>_TIN / _BHF_ID / _DVC_SRL_NO / _API_BASE_URL
// where <SLUG> is the tenant subdomain upper-cased with '-' replaced by '_'.
//
// NOTE ON THE eTIMS cmcKey: it is deliberately NOT seeded. The communication key
// is obtained from KRA by device initialization (POST /v1/etims/device/initialize),
// which writes it back into this blob. Seeding one would fake the single piece of
// state that proves a device is genuinely registered with KRA — so a freshly
// seeded tenant correctly reads as "credentials stored, device NOT initialized".

import { platformDb } from "../db/platform";
import { closePool } from "../db/pool";
import { disconnectAllTenantDbs, getTenantDb } from "../db/tenant";
import {
  activateCredential,
  putCredential,
  setIntegrationSetting,
} from "../services/credentials/credential-store";

const SEEDED_BY = "seed:credentials";

interface SeedDefaults {
  shortcode: string;
  label: string;
  /** The tenant's own KRA PIN. Distinct per tenant, deliberately (see the header). */
  tin: string;
  bhfId: string;
  dvcSrlNo: string;
}

// KRA's eTIMS sandbox host. Supplied per credential rather than derived, because a
// tenant's KRA onboarding pack names their endpoint and it has moved between
// revisions.
const ETIMS_SANDBOX_BASE_URL = "https://etims-api-sbx.kra.go.ke/etims-api";

// Per-tenant sandbox defaults. Distinct shortcodes per tenant: two tenants that
// resolved the same till would make a cross-tenant leak invisible.
const TENANT_DEFAULTS: Record<string, SeedDefaults> = {
  "nakuru-hardware": {
    shortcode: "174379",
    label: "Sandbox till 174379",
    tin: "P051111111A",
    bhfId: "00",
    dvcSrlNo: "SBX-NAKURU-0001",
  },
  "thika-agrovet": {
    shortcode: "600987",
    label: "Sandbox till 600987",
    tin: "P052222222B",
    bhfId: "00",
    dvcSrlNo: "SBX-THIKA-0001",
  },
};

const FALLBACK_DEFAULT: SeedDefaults = {
  shortcode: "174000",
  label: "Sandbox till 174000",
  tin: "P059999999Z",
  bhfId: "00",
  dvcSrlNo: "SBX-DEFAULT-0001",
};

function envKey(provider: "MPESA" | "ETIMS", subdomain: string, suffix: string): string {
  return `SEED_${provider}_${subdomain.toUpperCase().replace(/-/g, "_")}_${suffix}`;
}

function readOverride(
  subdomain: string,
  suffix: string,
  provider: "MPESA" | "ETIMS" = "MPESA",
): string | null {
  const value = process.env[envKey(provider, subdomain, suffix)];
  return value === undefined || value === "" ? null : value;
}

interface SeedSummaryRow {
  tenant: string;
  provider: string;
  environment: string;
  status: string;
  /** The non-secret identity this credential resolves to: a till, or a KRA PIN. */
  identity: string;
  source: string;
}

async function main(): Promise<void> {
  const tenants = await platformDb.tenant.findMany({
    where: { status: "ACTIVE" },
    select: { subdomain: true, dbSchema: true },
    orderBy: { subdomain: "asc" },
  });

  if (tenants.length === 0) {
    console.log("No ACTIVE tenants to seed credentials for.");
    return;
  }

  const summary: SeedSummaryRow[] = [];

  for (const tenant of tenants) {
    const defaults = TENANT_DEFAULTS[tenant.subdomain] ?? FALLBACK_DEFAULT;
    const shortcodeOverride = readOverride(tenant.subdomain, "SHORTCODE");
    const shortcode = shortcodeOverride ?? defaults.shortcode;

    const fields = {
      consumerKey:
        readOverride(tenant.subdomain, "CONSUMER_KEY") ??
        `sandbox-consumer-key-${tenant.subdomain}`,
      consumerSecret:
        readOverride(tenant.subdomain, "CONSUMER_SECRET") ??
        `sandbox-consumer-secret-${tenant.subdomain}`,
      passkey:
        readOverride(tenant.subdomain, "PASSKEY") ?? `sandbox-passkey-${tenant.subdomain}`,
      shortcode,
    };

    const db = getTenantDb(tenant.dbSchema);

    // Order matters: the credential must exist and be ACTIVE before the setting
    // can point at its environment — setIntegrationSetting refuses otherwise.
    await putCredential(db, {
      provider: "MPESA",
      environment: "SANDBOX",
      fields,
      label: shortcodeOverride === null ? defaults.label : `Sandbox till ${shortcode}`,
      createdBy: SEEDED_BY,
    });
    const activated = await activateCredential(db, "MPESA", "SANDBOX");
    const setting = await setIntegrationSetting(db, "MPESA", {
      activeEnvironment: "SANDBOX",
      enabled: true,
    });

    summary.push({
      tenant: tenant.subdomain,
      provider: "MPESA",
      environment: setting.activeEnvironment,
      status: activated.status,
      // The shortcode is a public paybill/till number, not a secret. No other
      // credential field is printed — and never will be.
      identity: `till ${shortcode}`,
      source: shortcodeOverride === null ? "seed default" : "env override",
    });

    // ---- KRA eTIMS (Task 4.1) --------------------------------------------
    //
    // The tenant's OWN KRA PIN and device. Angaza is never the integrator, so
    // there is nothing platform-level to seed here and no shared signer to fall
    // back on. cmcKey is deliberately absent — initialization obtains it.
    const tinOverride = readOverride(tenant.subdomain, "TIN", "ETIMS");
    const tin = tinOverride ?? defaults.tin;
    const etimsFields = {
      tin,
      bhfId: readOverride(tenant.subdomain, "BHF_ID", "ETIMS") ?? defaults.bhfId,
      dvcSrlNo: readOverride(tenant.subdomain, "DVC_SRL_NO", "ETIMS") ?? defaults.dvcSrlNo,
      apiBaseUrl:
        readOverride(tenant.subdomain, "API_BASE_URL", "ETIMS") ?? ETIMS_SANDBOX_BASE_URL,
    };

    await putCredential(db, {
      provider: "ETIMS",
      environment: "SANDBOX",
      fields: etimsFields,
      label: `Sandbox OSCU device ${etimsFields.dvcSrlNo}`,
      createdBy: SEEDED_BY,
    });
    const etimsActivated = await activateCredential(db, "ETIMS", "SANDBOX");
    const etimsSetting = await setIntegrationSetting(db, "ETIMS", {
      activeEnvironment: "SANDBOX",
      enabled: true,
    });

    summary.push({
      tenant: tenant.subdomain,
      provider: "ETIMS",
      environment: etimsSetting.activeEnvironment,
      status: etimsActivated.status,
      // A KRA PIN is printed on every fiscal receipt the business issues: it is
      // identity, not a secret. The cmcKey is neither printed nor seeded.
      identity: `TIN ${tin} / ${etimsFields.dvcSrlNo}`,
      source: tinOverride === null ? "seed default" : "env override",
    });
  }

  console.log("\nSeeded per-tenant SANDBOX credentials (encrypted at rest):");
  console.table(summary);
  console.log(
    "Secrets were encrypted with CREDENTIAL_ENCRYPTION_KEY and are not printed here.",
  );
  console.log(
    "eTIMS devices are NOT yet initialized: no cmcKey was seeded, because only KRA can issue one.",
  );
  console.log("Run POST /v1/etims/device/initialize per tenant to obtain and store it.\n");
}

main()
  .then(async () => {
    await platformDb.$disconnect();
    await disconnectAllTenantDbs();
    await closePool();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Credential seeding failed: ${message}`);
    await platformDb.$disconnect().catch((e: unknown) => {
      console.error("Cleanup: failed to disconnect platform client:", e);
    });
    await disconnectAllTenantDbs().catch((e: unknown) => {
      console.error("Cleanup: failed to disconnect tenant clients:", e);
    });
    await closePool().catch((e: unknown) => {
      console.error("Cleanup: failed to close pool:", e);
    });
    process.exit(1);
  });
