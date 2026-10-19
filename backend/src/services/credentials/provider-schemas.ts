// ===========================================================================
// Provider credential shapes (Task 3.4). This is the ONLY place a provider's
// credential blob shape is defined. The cipher and the credential store stay
// shape-agnostic — they move an opaque JSON object of string fields — so adding
// a provider is: add an enum value (schema), add a shape + parser here, and
// register it below. It is never a new table and never a migration.
//
// REGISTERED TODAY: MPESA (Task 3.4) and ETIMS (Task 4.1). STRIPE and SMS remain
// declared enum slots with NO registered shape, so the store is provider-generic
// from day one without anyone guessing their fields: those are decided by the
// task that builds the integration, and inventing them now would be guesswork
// baked into an encrypted blob. Attempting to store credentials for an
// unregistered provider is refused with a clear message — it is not silently
// accepted, and it is not a stub that pretends to validate.
//
// ADDING ETIMS COST EXACTLY WHAT THIS DESIGN PREDICTED: a shape and a parser in
// this file, plus one line in the registry. No new table, no migration to the
// credential store, no change to the cipher.
// ===========================================================================

import type { CredentialFieldMap } from "../../lib/crypto/credential-cipher";

export const INTEGRATION_PROVIDERS = ["MPESA", "ETIMS", "STRIPE", "SMS"] as const;

export type IntegrationProviderName = (typeof INTEGRATION_PROVIDERS)[number];

export const INTEGRATION_ENVIRONMENTS = ["SANDBOX", "PRODUCTION"] as const;

export type IntegrationEnvironmentName = (typeof INTEGRATION_ENVIRONMENTS)[number];

export function isIntegrationProvider(value: unknown): value is IntegrationProviderName {
  return (
    typeof value === "string" &&
    (INTEGRATION_PROVIDERS as readonly string[]).includes(value)
  );
}

export function isIntegrationEnvironment(
  value: unknown,
): value is IntegrationEnvironmentName {
  return (
    typeof value === "string" &&
    (INTEGRATION_ENVIRONMENTS as readonly string[]).includes(value)
  );
}

// Thrown when a credential blob is missing a required field, has a non-string
// field, or belongs to a provider with no registered shape. Distinct from
// CredentialDecryptError: the blob decrypted fine, its CONTENTS are wrong.
// Routes map it to 400. It never quotes a field VALUE — only the field name.
export class CredentialValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialValidationError";
  }
}

// ---- M-Pesa (Daraja) ------------------------------------------------------
// consumerKey/consumerSecret authenticate to the Daraja OAuth endpoint;
// shortcode is the tenant's own paybill/till (Option A: sales settle THERE);
// passkey signs the STK Push password. initiatorName/initiatorPassword are
// needed only for B2C/reversal APIs, which the POS flow does not use — optional.
export interface MpesaCredentialFields {
  readonly consumerKey: string;
  readonly consumerSecret: string;
  readonly shortcode: string;
  readonly passkey: string;
  readonly initiatorName?: string;
  readonly initiatorPassword?: string;
}

function requireField(
  fields: CredentialFieldMap,
  provider: IntegrationProviderName,
  name: string,
): string {
  const value = fields[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new CredentialValidationError(
      `${provider} credential is missing required field "${name}" (it must be a non-empty string).`,
    );
  }
  return value.trim();
}

function optionalField(fields: CredentialFieldMap, name: string): string | undefined {
  const value = fields[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

// Parse + validate in one pass, so validation and typed access can never drift
// apart. Throws CredentialValidationError naming the first missing field.
export function parseMpesaCredentialFields(
  fields: CredentialFieldMap,
): MpesaCredentialFields {
  return {
    consumerKey: requireField(fields, "MPESA", "consumerKey"),
    consumerSecret: requireField(fields, "MPESA", "consumerSecret"),
    shortcode: requireField(fields, "MPESA", "shortcode"),
    passkey: requireField(fields, "MPESA", "passkey"),
    initiatorName: optionalField(fields, "initiatorName"),
    initiatorPassword: optionalField(fields, "initiatorPassword"),
  };
}

// ---- KRA eTIMS (OSCU) -----------------------------------------------------
//
// ANGAZA IS NEVER THE KRA INTEGRATOR. Every field below belongs to the TENANT:
// they self-onboard on eTIMS under their own KRA PIN and enter their own device
// credentials. There is no Angaza-level eTIMS credential and no shared signer.
//
//   tin        the TENANT's own KRA PIN. Identifies whose invoice this is, so
//              taking it from anywhere other than the tenant's own store would
//              file one business's sales under another's PIN.
//   bhfId      branch id ("00" for a single-branch business).
//   dvcSrlNo   the device serial number registered with KRA.
//   cmcKey     the COMMUNICATION KEY that selectInitOsdcInfo returns at device
//              initialization and that must accompany every later request. It is
//              OPTIONAL here because it does not exist yet when the tenant first
//              stores their credentials: initialization obtains it and writes it
//              BACK into this blob. A credential with no cmcKey is storable but
//              cannot sign — the honest representation of "registered with KRA
//              but not yet initialized".
//   apiBaseUrl the eTIMS endpoint for the tenant's environment. Supplied rather
//              than derived (unlike Daraja's host) because KRA has distributed
//              several sandbox and production hosts and a tenant's onboarding
//              pack names theirs; hard-coding one would strand a tenant whose
//              pack differs.
//   authToken  an OAuth/bearer token where the tenant's onboarding issues one.
//              Optional: OSCU deployments differ on whether the cmcKey alone
//              authenticates.
//
// cmcKey AND authToken ARE SECRETS. Like every other blob field they are never
// returned by any API, never logged, and never written into an audit payload.
export interface EtimsCredentialFields {
  readonly tin: string;
  readonly bhfId: string;
  readonly dvcSrlNo: string;
  readonly cmcKey?: string;
  readonly apiBaseUrl: string;
  readonly authToken?: string;
}

export function parseEtimsCredentialFields(
  fields: CredentialFieldMap,
): EtimsCredentialFields {
  const cmcKey = optionalField(fields, "cmcKey");
  const authToken = optionalField(fields, "authToken");
  return {
    tin: requireField(fields, "ETIMS", "tin"),
    bhfId: requireField(fields, "ETIMS", "bhfId"),
    dvcSrlNo: requireField(fields, "ETIMS", "dvcSrlNo"),
    apiBaseUrl: requireField(fields, "ETIMS", "apiBaseUrl"),
    ...(cmcKey !== undefined ? { cmcKey } : {}),
    ...(authToken !== undefined ? { authToken } : {}),
  };
}

// ===========================================================================
// PLATFORM notification credentials (Task T-A3).
//
// These are ANGAZA's OWN credentials — the SMS account and the email account the
// platform sends password-reset codes and staff invitations from — stored in
// `public.platform_integration_credentials`, never in a tenant schema and never in
// env. They are deliberately a SEPARATE registry from the tenant-facing
// INTEGRATION_PROVIDERS above: the tenant enum's SMS slot is a tenant's own SMS
// integration (still unregistered), which is a different thing from the platform's.
// ===========================================================================

export const PLATFORM_NOTIFICATION_PROVIDERS = ["AFRICASTALKING", "SENDGRID"] as const;

export type PlatformNotificationProviderName = (typeof PLATFORM_NOTIFICATION_PROVIDERS)[number];

// ---- Africa's Talking SMS -------------------------------------------------
//   username   the Africa's Talking application username. The literal "sandbox"
//              selects AT's sandbox host — that is AT's own convention, so the host
//              is DERIVED, never configured.
//   apiKey     the application API key (SECRET).
//   senderId   an approved alphanumeric sender id / shortcode; optional (AT falls
//              back to its shared sender).
export interface AfricasTalkingCredentialFields {
  readonly username: string;
  readonly apiKey: string;
  readonly senderId?: string;
}

export function parseAfricasTalkingCredentialFields(
  fields: CredentialFieldMap,
): AfricasTalkingCredentialFields {
  const senderId = optionalField(fields, "senderId");
  return {
    username: requirePlatformField(fields, "AFRICASTALKING", "username"),
    apiKey: requirePlatformField(fields, "AFRICASTALKING", "apiKey"),
    ...(senderId !== undefined ? { senderId } : {}),
  };
}

// ---- SendGrid transactional email (v3 /mail/send over HTTPS) --------------
//   apiKey     a SendGrid API key with Mail Send permission (SECRET).
//   fromEmail  the verified sender address.
//   fromName   optional display name.
export interface SendgridCredentialFields {
  readonly apiKey: string;
  readonly fromEmail: string;
  readonly fromName?: string;
}

export function parseSendgridCredentialFields(
  fields: CredentialFieldMap,
): SendgridCredentialFields {
  const fromName = optionalField(fields, "fromName");
  return {
    apiKey: requirePlatformField(fields, "SENDGRID", "apiKey"),
    fromEmail: requirePlatformField(fields, "SENDGRID", "fromEmail"),
    ...(fromName !== undefined ? { fromName } : {}),
  };
}

function requirePlatformField(
  fields: CredentialFieldMap,
  provider: PlatformNotificationProviderName,
  name: string,
): string {
  const value = fields[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new CredentialValidationError(
      `${provider} platform credential is missing required field "${name}" (it must be a non-empty string).`,
    );
  }
  return value.trim();
}

/** The field name device initialization writes the communication key back into. */
export const ETIMS_CMC_KEY_FIELD = "cmcKey";

/**
 * Field names that are SECRETS across every registered provider. Used to strip
 * them out of anything persisted or logged — an audit record of a submitted
 * request is a stored credential if you are careless about this.
 */
export const SECRET_CREDENTIAL_FIELDS: readonly string[] = [
  "cmcKey",
  "authToken",
  "consumerSecret",
  "passkey",
  "initiatorPassword",
  // Platform notification providers (Task T-A3).
  "apiKey",
];

// The registry. `null` means "declared provider, shape not registered yet" —
// see the header. A provider gains its shape in the task that builds it.
const CREDENTIAL_PARSERS: {
  readonly [P in IntegrationProviderName]: ((fields: CredentialFieldMap) => unknown) | null;
} = {
  MPESA: parseMpesaCredentialFields,
  ETIMS: parseEtimsCredentialFields,
  STRIPE: null,
  SMS: null,
};

// Dispatch. Unknown provider throws; a declared-but-unregistered provider
// throws with a different, equally explicit message.
export function validateCredentialFields(
  provider: string,
  fields: CredentialFieldMap,
): void {
  if (!isIntegrationProvider(provider)) {
    throw new CredentialValidationError(
      `Unknown integration provider "${provider}". Supported providers: ${INTEGRATION_PROVIDERS.join(", ")}.`,
    );
  }
  const parser = CREDENTIAL_PARSERS[provider];
  if (parser === null) {
    throw new CredentialValidationError(
      `Integration provider "${provider}" has no registered credential shape yet, so its credentials cannot be validated or stored. The shape is defined by the task that builds that integration.`,
    );
  }
  parser(fields);
}

// Which providers can actually accept credentials today. Used by the settings
// route to describe the store honestly rather than advertising slots that would
// reject every write.
export function hasRegisteredCredentialShape(provider: IntegrationProviderName): boolean {
  return CREDENTIAL_PARSERS[provider] !== null;
}
