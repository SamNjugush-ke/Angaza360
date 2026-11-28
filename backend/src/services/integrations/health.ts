// ===========================================================================
// INTEGRATION LIVE-VERIFY + HEALTH (M4.5 Wave 1, T-B1 — closes G-12).
//
// `verifyIntegration` tests a business's STORED credentials for M-Pesa or eTIMS against
// the provider (the simulator in development) through that provider's factory — the only
// place plaintext is consumed — and records the outcome:
//
//   * on the business's OWN credential row (tenant migration 0034): healthStatus
//     HEALTHY | FAILING, lastHealthCheckAt, lastHealthError (in words), and on success
//     lastVerifiedAt — through the credential store, its sole writer;
//   * in the PLATFORM mirror `integration_health`, in the SAME transaction (the T-A13
//     mirroring pattern), so the Command Center reads every business's health without a
//     cross-schema query. The mirror holds no credential and no business data.
//
// NO SECRET LEAVES: the factories scrub every stored field value out of a provider's
// words before they reach this module, and nothing here sees plaintext.
// ===========================================================================

import type { TenantContext } from "../../auth/tenant-registry";
import { platformDb } from "../../db/platform";
import type { PrismaClient as TenantPrismaClient } from "../../generated/tenant/client";
import type { IntegrationEnvironment } from "../../generated/tenant/enums";
import {
  getIntegrationSetting,
  listCredentialsSafe,
  recordCredentialHealthWithinTransaction,
  type CredentialSafeView,
} from "../credentials/credential-store";
import { probeEtimsCredentials } from "../etims/factory";
import { probeMpesaCredentials } from "../mpesa/factory";

export const VERIFIABLE_PROVIDERS = ["MPESA", "ETIMS"] as const;
export type VerifiableProvider = (typeof VERIFIABLE_PROVIDERS)[number];

export interface VerifyResult {
  readonly provider: VerifiableProvider;
  readonly environment: IntegrationEnvironment;
  readonly ok: boolean;
  readonly detail: string;
  readonly credential: CredentialSafeView;
}

export async function verifyIntegration(
  db: TenantPrismaClient,
  tenant: TenantContext,
  provider: VerifiableProvider,
  environment: IntegrationEnvironment | null,
): Promise<VerifyResult> {
  const target = environment ?? (await getIntegrationSetting(db, provider)).activeEnvironment;
  // Throws NoActiveCredentialError when nothing is stored for (provider, environment).
  const probe = provider === "MPESA" ? await probeMpesaCredentials(db, tenant, target) : await probeEtimsCredentials(db, target);
  const at = new Date();
  const credential = await db.$transaction(async (tx) => {
    const view = await recordCredentialHealthWithinTransaction(tx, provider, target, {
      ok: probe.ok,
      error: probe.ok ? null : probe.detail,
      at,
    });
    await tx.$executeRawUnsafe(
      `INSERT INTO public."integration_health" ("tenantId", "provider", "environment", "status", "lastCheckAt", "lastVerifiedAt", "lastError", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT ("tenantId", "provider", "environment") DO UPDATE SET
         "status" = EXCLUDED."status", "lastCheckAt" = EXCLUDED."lastCheckAt",
         "lastVerifiedAt" = COALESCE(EXCLUDED."lastVerifiedAt", public."integration_health"."lastVerifiedAt"),
         "lastError" = EXCLUDED."lastError", "updatedAt" = now()`,
      tenant.tenantId,
      provider,
      target,
      probe.ok ? "HEALTHY" : "FAILING",
      at,
      probe.ok ? at : view.lastVerifiedAt,
      probe.ok ? null : view.lastHealthError,
    );
    return view;
  });
  return { provider, environment: target, ok: probe.ok, detail: probe.detail, credential };
}

/** This business's health, per verifiable provider and environment. */
export async function listIntegrationHealth(db: TenantPrismaClient): Promise<CredentialSafeView[]> {
  const stored = await listCredentialsSafe(db);
  return stored.filter((row) => (VERIFIABLE_PROVIDERS as readonly string[]).includes(row.provider));
}

export interface PlatformHealthRow {
  readonly tenantId: string;
  readonly businessName: string | null;
  readonly provider: string;
  readonly environment: string;
  readonly status: string;
  readonly lastCheckAt: Date;
  readonly lastVerifiedAt: Date | null;
  readonly lastError: string | null;
}

/** The Command Center's read (Wave 5): every business's last verify, failing first. */
export async function listPlatformIntegrationHealth(filters: { status: string | null; tenantId?: string | null }): Promise<PlatformHealthRow[]> {
  const rows = await platformDb.integrationHealth.findMany({
    where: { ...(filters.status === null ? {} : { status: filters.status }), ...(filters.tenantId ? { tenantId: filters.tenantId } : {}) },
    orderBy: [{ status: "asc" }, { lastCheckAt: "desc" }],
    take: 500,
  });
  const tenants = await platformDb.tenant.findMany({
    where: { id: { in: [...new Set(rows.map((row) => row.tenantId))] } },
    select: { id: true, name: true },
  });
  const names = new Map(tenants.map((tenant) => [tenant.id, tenant.name]));
  return rows.map(({ updatedAt: _updated, ...row }) => ({ ...row, businessName: names.get(row.tenantId) ?? null }));
}
