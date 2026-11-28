// ===========================================================================
// eTIMS provider factory (Task 4.1). Mirrors src/services/mpesa/factory.ts.
//
// THIS IS THE ONLY PLACE either concrete eTIMS provider is named, and the ONLY
// place a decrypted eTIMS credential is consumed. Everything else — invoice
// numbering, persistence, the fiscalStatus transition, retry policy — depends
// solely on the EtimsProvider interface and never learns which implementation is
// in play. That is what makes going live a config change:
//
//   tenant's IntegrationSetting -> which environment is live (SANDBOX/PRODUCTION)
//   tenant's ACTIVE credential  -> that environment's own TIN/device/cmcKey
//   ETIMS_PROVIDER (deployment) -> which implementation to construct
//
// ---------------------------------------------------------------------------
// OPTION A IS ABSOLUTE FOR FISCAL IDENTITY, AND STRICTER THAN FOR MONEY.
//
// There is NO Angaza-level eTIMS credential, NO shared signer, and — unlike the
// M-Pesa simulator's dev shortcode — NO FALLBACK OF ANY KIND, in either mode.
//
// The reason is worth stating: a borrowed shortcode misroutes money, which is
// recoverable. A borrowed TIN files one business's sales as another business's
// revenue with the Kenya Revenue Authority, under a PIN its owner never
// authorised. That is a tax misdeclaration against a third party, and no
// convenience justifies risking it. A tenant without active eTIMS credentials
// simply cannot sign — and that is harmless, because a sale is validly finalized
// without a fiscal invoice.
// ---------------------------------------------------------------------------
// ===========================================================================

import { env } from "../../config/env";
import type { PrismaClient as TenantPrismaClient } from "../../generated/tenant/client";
import type { IntegrationEnvironment } from "../../generated/tenant/enums";
import {
  getActiveEtimsCredentialFields,
  getIntegrationSetting,
} from "../credentials/credential-store";
import type { EtimsCredentialFields } from "../credentials/provider-schemas";
import type { EtimsProvider } from "./provider";
import { SimulatedEtimsProvider } from "./simulated-provider";
import { RealOscuProvider } from "./oscu-provider";
import { scrubSecrets } from "../credentials/scrub";

/**
 * The tenant has eTIMS credentials but has switched the integration off. Distinct
 * from NoActiveCredentialError ("never configured"), because the operator actions
 * differ: one enables a setting, the other completes an onboarding.
 */
export class EtimsDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EtimsDisabledError";
  }
}

export interface ResolvedEtimsProvider {
  readonly provider: EtimsProvider;
  /** Which of the tenant's credential environments served this construction. */
  readonly environment: IntegrationEnvironment;
  /**
   * The tenant's own decrypted credentials. Returned because the signing service
   * must pass them to the provider on every call and must read tin/bhfId/dvcSrlNo
   * to resolve the device row. NEVER logged, never persisted, never serialised
   * into a response.
   */
  readonly credentials: EtimsCredentialFields;
  /** Whether KRA has issued this device a communication key yet. */
  readonly initialized: boolean;
}

export async function getEtimsProviderForTenant(
  db: TenantPrismaClient,
  options: { requireEnabled?: boolean } = {},
): Promise<ResolvedEtimsProvider> {
  const setting = await getIntegrationSetting(db, "ETIMS");
  const environment = setting.activeEnvironment;

  // Credentials first: "this tenant has not onboarded eTIMS" is the most
  // diagnostic failure and must not be masked by the enabled flag. Throws
  // NoActiveCredentialError, which every caller maps to a clear "not configured".
  const credentials = await getActiveEtimsCredentialFields(db, environment);

  // Device initialization is the one place the enabled flag is not required: an
  // owner must be able to initialize before switching the integration on.
  if (options.requireEnabled === true && !setting.enabled) {
    throw new EtimsDisabledError(
      "eTIMS is switched off for this tenant. Enable the integration in settings before requesting KRA invoices. Sales continue to finalize normally without it.",
    );
  }

  const providerName = env.etims.provider;
  switch (providerName) {
    case "simulated":
      return {
        provider: new SimulatedEtimsProvider({ outcomeOverride: env.etims.simOutcome }),
        environment,
        credentials,
        initialized: credentials.cmcKey !== undefined && credentials.cmcKey !== "",
      };
    case "oscu":
      return {
        provider: new RealOscuProvider(),
        environment,
        credentials,
        initialized: credentials.cmcKey !== undefined && credentials.cmcKey !== "",
      };
    default: {
      const exhaustive: never = providerName;
      throw new Error(`Unknown ETIMS_PROVIDER "${String(exhaustive)}".`);
    }
  }
}

/**
 * LIVE VERIFY (M4.5 W1, T-B1): tests the STORED eTIMS credentials for `environment` (ACTIVE
 * or PENDING) with a harmless KRA read. A device that has not been initialized cannot be
 * probed — that is reported as the failure it is. Throws NoActiveCredentialError when
 * nothing is stored; otherwise the result, with every stored field value scrubbed out.
 */
export async function probeEtimsCredentials(
  db: TenantPrismaClient,
  environment: IntegrationEnvironment,
): Promise<{ ok: boolean; detail: string }> {
  const credentials = await getActiveEtimsCredentialFields(db, environment, { forVerification: true });
  const secrets = [credentials.tin, credentials.bhfId, credentials.dvcSrlNo, credentials.cmcKey, credentials.authToken];
  if (credentials.cmcKey === undefined || credentials.cmcKey === "") {
    return { ok: false, detail: "The eTIMS device has not been initialized yet (no communication key): initialize it, then verify." };
  }
  const providerName = env.etims.provider;
  const provider: EtimsProvider =
    providerName === "simulated" ? new SimulatedEtimsProvider({ outcomeOverride: env.etims.simOutcome }) : new RealOscuProvider();
  try {
    const result = await provider.probe(credentials);
    return { ok: result.ok, detail: scrubSecrets(result.detail, secrets) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "eTIMS could not be verified.";
    return { ok: false, detail: scrubSecrets(message, secrets) };
  }
}
