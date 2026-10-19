// ===========================================================================
// M-Pesa provider factory (Task 3.3; made PER-TENANT in Task 3.4).
//
// This is the ONLY place either concrete provider is named, and the ONLY place
// a decrypted credential is consumed. Everything else — the webhook,
// idempotency, tender confirmation, ledger posting — depends solely on the
// MpesaProvider interface.
//
// WHAT 3.4 CHANGED: provider construction is no longer a process-wide singleton
// built from process-wide env credentials. It is resolved PER REQUEST from the
// calling tenant's own encrypted credential store:
//
//   tenant's IntegrationSetting  -> which environment is live (SANDBOX/PRODUCTION)
//   tenant's ACTIVE credential   -> that environment's secrets, decrypted here
//   MPESA_PROVIDER (deployment)  -> which implementation to construct
//
// So there are exactly two levers, and both are config: MPESA_PROVIDER selects
// the implementation, and the tenant's activeEnvironment selects which of their
// credential rows serves traffic. Going live is activating a PRODUCTION
// credential and flipping activeEnvironment — never a deploy, never a code
// change to anything below this file.
//
// OPTION A IS ENFORCED HERE: under the real provider there is NO fallback to a
// shared/global shortcode. A tenant without active credentials gets a clear
// error, because settling one shop's sale into another party's till is worse
// than failing the sale.
//
// Callback PARSING is separate (getMpesaCallbackParser): it needs no
// credentials, so the public webhook can still parse an inbound callback before
// it has resolved a tenant — unchanged from 3.3.
// ===========================================================================

import { env } from "../../config/env";
import type { TenantContext } from "../../auth/tenant-registry";
import type { PrismaClient as TenantPrismaClient } from "../../generated/tenant/client";
import type { IntegrationEnvironment } from "../../generated/tenant/enums";
import {
  getActiveMpesaCredentialFields,
  getIntegrationSetting,
  NoActiveCredentialError,
} from "../credentials/credential-store";
import type { MpesaCallbackParser, MpesaProvider } from "./provider";
import { SimulatedCallbackParser, SimulatedMpesaProvider } from "./simulated-provider";
import { DarajaCallbackParser, DarajaMpesaProvider } from "./daraja-provider";

// The tenant has credentials but has switched the integration off. Distinct
// from NoActiveCredentialError ("never configured"). Routes map both to 400.
export class IntegrationDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationDisabledError";
  }
}

export interface ResolvedMpesaProvider {
  readonly provider: MpesaProvider;
  // Which of the tenant's credential environments served this construction.
  readonly environment: IntegrationEnvironment;
  // The tenant's own paybill/till. NOT a secret (customers pay to it), and the
  // one credential field that is meaningful to surface: it is the proof that
  // this tenant's money is going to this tenant's shortcode.
  readonly shortcode: string;
  readonly credentialSource: "tenant-store" | "dev-fallback";
}

// Daraja's API host is DERIVED from the tenant's active environment rather than
// configured, so that flipping activeEnvironment moves a tenant between
// Safaricom's sandbox and production with no other change anywhere.
function darajaBaseUrl(environment: IntegrationEnvironment): string {
  return environment === "PRODUCTION"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";
}

// The callback URL is SERVER-GENERATED per tenant: the unguessable path secret
// plus the tenant's registered slug. It is never taken from a request, and it
// is what lets the webhook resolve tenant identity from the path instead of
// from an untrusted callback body.
function buildCallbackUrl(tenant: TenantContext): string {
  const base = env.mpesa.callbackBaseUrl;
  if (base === null) {
    throw new Error(
      "MPESA_CALLBACK_BASE_URL is not configured; the real Daraja provider cannot build a callback URL Safaricom can reach.",
    );
  }
  return `${base}/v1/webhooks/mpesa/${env.mpesa.callbackPathSecret}/${tenant.subdomain}`;
}

export async function getMpesaProviderForTenant(
  db: TenantPrismaClient,
  tenant: TenantContext,
): Promise<ResolvedMpesaProvider> {
  const setting = await getIntegrationSetting(db, "MPESA");
  const environment = setting.activeEnvironment;
  const providerName = env.mpesa.provider;

  switch (providerName) {
    case "simulated": {
      // The simulator needs no real credentials, but it STILL resolves the
      // tenant's environment and (when present) decrypts their credential — so
      // the resolution path that production depends on is exercised in
      // development instead of being dead until go-live. A tenant that has not
      // been seeded yet falls back to the dev shortcode; that fallback exists
      // ONLY here, under the simulator.
      let shortcode: string;
      let credentialSource: ResolvedMpesaProvider["credentialSource"];
      try {
        const fields = await getActiveMpesaCredentialFields(db, environment);
        shortcode = fields.shortcode;
        credentialSource = "tenant-store";
      } catch (error) {
        if (!(error instanceof NoActiveCredentialError)) {
          throw error;
        }
        shortcode = env.mpesa.devFallbackShortcode ?? "SIMULATED-NO-SHORTCODE";
        credentialSource = "dev-fallback";
      }
      return {
        provider: new SimulatedMpesaProvider(),
        environment,
        shortcode,
        credentialSource,
      };
    }
    case "daraja": {
      // Credentials first: "this tenant has not onboarded M-Pesa" is the most
      // diagnostic failure and must not be masked by the enabled flag.
      const fields = await getActiveMpesaCredentialFields(db, environment);
      if (!setting.enabled) {
        throw new IntegrationDisabledError(
          `M-Pesa is switched off for this tenant. Enable the integration in settings before taking M-Pesa payments.`,
        );
      }
      return {
        provider: new DarajaMpesaProvider({
          baseUrl: darajaBaseUrl(environment),
          consumerKey: fields.consumerKey,
          consumerSecret: fields.consumerSecret,
          passkey: fields.passkey,
          shortcode: fields.shortcode,
          callbackUrl: buildCallbackUrl(tenant),
        }),
        environment,
        shortcode: fields.shortcode,
        credentialSource: "tenant-store",
      };
    }
    default: {
      const exhaustive: never = providerName;
      throw new Error(`Unknown MPESA_PROVIDER "${String(exhaustive)}".`);
    }
  }
}

// Credential-free: which wire format inbound callbacks are in is a property of
// the deployment's provider, not of a tenant. The public webhook uses this
// BEFORE resolving a tenant, exactly as in 3.3.
export function getMpesaCallbackParser(): MpesaCallbackParser {
  const providerName = env.mpesa.provider;
  switch (providerName) {
    case "simulated":
      return new SimulatedCallbackParser();
    case "daraja":
      return new DarajaCallbackParser();
    default: {
      const exhaustive: never = providerName;
      throw new Error(`Unknown MPESA_PROVIDER "${String(exhaustive)}".`);
    }
  }
}
