// ===========================================================================
// Integration credential store (Task 3.4).
//
// THIS IS THE ONLY MODULE that reads or writes `tenant_integration_credentials`
// and `integration_settings`, and the ONLY module that decrypts a credential
// blob. No route, no provider, no script touches those tables directly. A
// decrypted credential leaves this service through exactly one door PER
// PROVIDER, each called by that provider's factory and nothing else:
// getActiveMpesaCredentialFields (M-Pesa, 3.4) and getActiveEtimsCredentialFields
// (eTIMS, 4.1) for TENANT credentials; getActiveAfricasTalkingCredentialFields and
// getActiveSendgridCredentialFields (notifications, T-A3) for the PLATFORM's own
// credentials in public.platform_integration_credentials (read-only here; see the
// section at the end). Every other exported read returns a SAFE view: identity,
// environment, status, label, keyRef and timestamps, never the blob and never a
// secret.
//
// NOTHING HERE LOGS. Not the fields, not the blob, not the key. A credential
// that is printed once is a credential that is in a log aggregator forever.
//
// ISOLATION: every function takes the request's already-resolved tenant Prisma
// client. The client determines the schema, so a caller cannot ask for another
// tenant's credentials — there is no tenant/schema parameter to abuse.
// ===========================================================================

import type { PrismaClient as TenantPrismaClient } from "../../generated/tenant/client";
import type {
  CredentialStatus,
  IntegrationEnvironment,
  IntegrationProvider,
} from "../../generated/tenant/enums";
import {
  decryptCredential,
  encryptCredential,
  parseCredentialFields,
  serialiseCredentialFields,
  type CredentialFieldMap,
} from "../../lib/crypto/credential-cipher";
import {
  parseAfricasTalkingCredentialFields,
  parseEtimsCredentialFields,
  parseMpesaCredentialFields,
  parseSendgridCredentialFields,
  validateCredentialFields,
  type AfricasTalkingCredentialFields,
  type EtimsCredentialFields,
  type MpesaCredentialFields,
  type PlatformNotificationProviderName,
  type SendgridCredentialFields,
} from "./provider-schemas";
import { env } from "../../config/env";
import { platformDb } from "../../db/platform";

// The provider factory asked for an ACTIVE credential and there is none for
// that (provider, environment). Distinct so callers can tell "this tenant has
// not onboarded this integration" from "this integration is broken".
export class NoActiveCredentialError extends Error {
  readonly provider: IntegrationProvider;
  readonly environment: IntegrationEnvironment;

  constructor(provider: IntegrationProvider, environment: IntegrationEnvironment) {
    super(
      `This tenant has no active ${provider} credentials for the ${environment} environment. Store the credentials and activate them before using the integration.`,
    );
    this.name = "NoActiveCredentialError";
    this.provider = provider;
    this.environment = environment;
  }
}

// A settings change was refused: it would point activeEnvironment at an
// environment with no ACTIVE credential. Routes map it to 400. This is the
// guard behind the "Go Live" control.
export class IntegrationSettingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationSettingError";
  }
}

// What may leave this service for a UI. No ciphertext, no iv, no authTag, and
// above all no decrypted field. keyRef IS included: it names which key encrypted
// the row (the KMS-migration seam), and naming a key is not disclosing it.
export interface CredentialSafeView {
  readonly id: string;
  readonly provider: IntegrationProvider;
  readonly environment: IntegrationEnvironment;
  readonly status: CredentialStatus;
  readonly label: string | null;
  readonly keyRef: string;
  readonly lastVerifiedAt: Date | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface IntegrationSettingView {
  readonly provider: IntegrationProvider;
  readonly activeEnvironment: IntegrationEnvironment;
  readonly enabled: boolean;
  // false when the tenant has never saved a setting for this provider and the
  // values above are the defaults. Callers must not need to distinguish them to
  // behave correctly — the defaults ARE the meaning of "no row" — but the
  // settings UI shows it honestly.
  readonly configured: boolean;
  readonly updatedAt: Date | null;
}

interface CredentialRow {
  id: string;
  provider: IntegrationProvider;
  environment: IntegrationEnvironment;
  status: CredentialStatus;
  label: string | null;
  keyRef: string;
  lastVerifiedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// The exact column set a SAFE view is built from. Selecting explicitly (rather
// than selecting the row and deleting fields) means a future column cannot leak
// by default.
const SAFE_SELECT = {
  id: true,
  provider: true,
  environment: true,
  status: true,
  label: true,
  keyRef: true,
  lastVerifiedAt: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const;

function toSafeView(row: CredentialRow): CredentialSafeView {
  return {
    id: row.id,
    provider: row.provider,
    environment: row.environment,
    status: row.status,
    label: row.label,
    keyRef: row.keyRef,
    lastVerifiedAt: row.lastVerifiedAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface PutCredentialInput {
  readonly provider: IntegrationProvider;
  readonly environment: IntegrationEnvironment;
  readonly fields: CredentialFieldMap;
  readonly label?: string | null;
  readonly createdBy: string;
}

// Store (or rotate) a credential set. Validate first — an unstorable blob must
// never reach the database — then encrypt, then upsert by (provider,
// environment). The row lands PENDING: storing a credential is not the same as
// putting it into service, and activation is a separate, deliberate act.
// Returns a SAFE view; the secrets that came in never come back out.
export async function putCredential(
  db: TenantPrismaClient,
  input: PutCredentialInput,
): Promise<CredentialSafeView> {
  validateCredentialFields(input.provider, input.fields);

  const encrypted = encryptCredential(serialiseCredentialFields(input.fields));
  const label = input.label ?? null;

  const row = await db.tenantIntegrationCredential.upsert({
    where: {
      provider_environment: { provider: input.provider, environment: input.environment },
    },
    create: {
      provider: input.provider,
      environment: input.environment,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      keyRef: encrypted.keyRef,
      status: "PENDING",
      label,
      createdBy: input.createdBy,
    },
    update: {
      // Rotation: the blob is replaced wholesale (new IV, new tag, current
      // keyRef) and the row returns to PENDING with its verification cleared —
      // a rotated credential has not been proven to work yet. Identity
      // (provider/environment) and createdBy/createdAt are untouched here and
      // are additionally protected by the DB trigger from migration 0010.
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      keyRef: encrypted.keyRef,
      status: "PENDING",
      label,
      lastVerifiedAt: null,
    },
    select: SAFE_SELECT,
  });

  return toSafeView(row);
}

// Put a stored credential into service. The partial unique index from migration
// 0010 guarantees at most one ACTIVE row per (provider, environment); the
// @@unique means there is only one row per pair to begin with, so there is
// nothing to demote. Activation also re-validates by decrypting: a row that
// cannot be decrypted and parsed must never be marked ACTIVE, because the
// factory would then fail at the till instead of here.
export async function activateCredential(
  db: TenantPrismaClient,
  provider: IntegrationProvider,
  environment: IntegrationEnvironment,
): Promise<CredentialSafeView> {
  const existing = await db.tenantIntegrationCredential.findUnique({
    where: { provider_environment: { provider, environment } },
  });
  if (existing === null) {
    throw new NoActiveCredentialError(provider, environment);
  }

  // Throws CredentialDecryptError / CredentialValidationError to the caller.
  const fields = decryptFields(existing);
  validateCredentialFields(provider, fields);

  const row = await db.tenantIntegrationCredential.update({
    where: { id: existing.id },
    data: { status: "ACTIVE", lastVerifiedAt: new Date() },
    select: SAFE_SELECT,
  });
  return toSafeView(row);
}

interface EncryptedRow {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyRef: string;
}

// The single decryption point in the system.
function decryptFields(row: EncryptedRow): CredentialFieldMap {
  return parseCredentialFields(
    decryptCredential({
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.authTag,
      keyRef: row.keyRef,
    }),
  );
}

// Load, decrypt and validate the ACTIVE credential for (provider, environment).
// This is what the provider factory calls, and it is the ONLY exported function
// that returns plaintext. It never logs its result.
export async function getActiveCredentialFields(
  db: TenantPrismaClient,
  provider: IntegrationProvider,
  environment: IntegrationEnvironment,
): Promise<CredentialFieldMap> {
  const row = await db.tenantIntegrationCredential.findFirst({
    where: { provider, environment, status: "ACTIVE" },
  });
  if (row === null) {
    throw new NoActiveCredentialError(provider, environment);
  }
  const fields = decryptFields(row);
  validateCredentialFields(provider, fields);
  return fields;
}

// Typed accessors, one per provider with a registered shape. Each is a door
// through which plaintext leaves this service, and each is called by exactly one
// provider factory. The generic loader above is unchanged by adding one.
export async function getActiveMpesaCredentialFields(
  db: TenantPrismaClient,
  environment: IntegrationEnvironment,
): Promise<MpesaCredentialFields> {
  const fields = await getActiveCredentialFields(db, "MPESA", environment);
  return parseMpesaCredentialFields(fields);
}

// Task 4.1. Called only by src/services/etims/factory.ts. The tenant's own KRA
// PIN and OSCU device credentials — there is no Angaza-level eTIMS credential to
// fall back to, which is the whole of Option A for fiscal identity: a tenant
// without one cannot sign, and must never sign under someone else's PIN.
export async function getActiveEtimsCredentialFields(
  db: TenantPrismaClient,
  environment: IntegrationEnvironment,
): Promise<EtimsCredentialFields> {
  const fields = await getActiveCredentialFields(db, "ETIMS", environment);
  return parseEtimsCredentialFields(fields);
}

/**
 * MERGE new field values into an ACTIVE credential's blob, IN PLACE, without
 * changing its status.
 *
 * This exists for ONE case, and the distinction from putCredential matters:
 * eTIMS device initialization obtains a cmcKey from KRA and must write it back
 * into the stored blob. putCredential is a ROTATION — it replaces the blob
 * wholesale and returns the row to PENDING with its verification cleared, which
 * is right when a human supplies new secrets and wrong here: initialization would
 * then DEACTIVATE the very credential it just initialized, and the next sale
 * would fail at the till.
 *
 * So this re-encrypts the decrypted blob with the named fields replaced, leaves
 * status and lastVerifiedAt alone, and validates the RESULT before writing — a
 * merge that produced an invalid credential must never reach the database.
 *
 * Still the only module that decrypts, and still nothing is logged.
 */
export async function mergeCredentialFields(
  db: TenantPrismaClient,
  provider: IntegrationProvider,
  environment: IntegrationEnvironment,
  patch: CredentialFieldMap,
): Promise<CredentialSafeView> {
  const existing = await db.tenantIntegrationCredential.findFirst({
    where: { provider, environment, status: "ACTIVE" },
  });
  if (existing === null) {
    throw new NoActiveCredentialError(provider, environment);
  }

  const merged: CredentialFieldMap = { ...decryptFields(existing), ...patch };
  validateCredentialFields(provider, merged);

  const encrypted = encryptCredential(serialiseCredentialFields(merged));
  const row = await db.tenantIntegrationCredential.update({
    where: { id: existing.id },
    data: {
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      keyRef: encrypted.keyRef,
      // status and lastVerifiedAt deliberately untouched: this is a field merge
      // on a credential already in service, not a rotation of it.
    },
    select: SAFE_SELECT,
  });
  return toSafeView(row);
}

// ---- Settings -------------------------------------------------------------

const DEFAULT_ACTIVE_ENVIRONMENT: IntegrationEnvironment = "SANDBOX";

// No row means "SANDBOX, not enabled" — a tenant that has never touched an
// integration has not turned it on and is certainly not live. The absence of a
// row is a meaning, not a missing value, so callers never have to handle null.
export async function getIntegrationSetting(
  db: TenantPrismaClient,
  provider: IntegrationProvider,
): Promise<IntegrationSettingView> {
  const row = await db.integrationSetting.findUnique({ where: { provider } });
  if (row === null) {
    return {
      provider,
      activeEnvironment: DEFAULT_ACTIVE_ENVIRONMENT,
      enabled: false,
      configured: false,
      updatedAt: null,
    };
  }
  return {
    provider: row.provider,
    activeEnvironment: row.activeEnvironment,
    enabled: row.enabled,
    configured: true,
    updatedAt: row.updatedAt,
  };
}

export interface SetIntegrationSettingInput {
  readonly activeEnvironment?: IntegrationEnvironment;
  readonly enabled?: boolean;
}

// The "Go Live" control. Flipping activeEnvironment SANDBOX -> PRODUCTION is how
// a tenant goes live, and it is refused unless an ACTIVE credential exists for
// the environment being pointed at. That rule is enforced HERE, in the service,
// so it holds for every caller (route, script, future admin tool) and not just
// for the one that remembered to check.
export async function setIntegrationSetting(
  db: TenantPrismaClient,
  provider: IntegrationProvider,
  input: SetIntegrationSettingInput,
): Promise<IntegrationSettingView> {
  const current = await getIntegrationSetting(db, provider);
  const nextEnvironment = input.activeEnvironment ?? current.activeEnvironment;
  const nextEnabled = input.enabled ?? current.enabled;

  const active = await db.tenantIntegrationCredential.findFirst({
    where: { provider, environment: nextEnvironment, status: "ACTIVE" },
    select: { id: true },
  });
  if (active === null) {
    throw new IntegrationSettingError(
      `Cannot point ${provider} at the ${nextEnvironment} environment: no ACTIVE ${nextEnvironment} credential is configured for this tenant. Store the ${nextEnvironment} credentials and activate them first.`,
    );
  }

  const row = await db.integrationSetting.upsert({
    where: { provider },
    create: { provider, activeEnvironment: nextEnvironment, enabled: nextEnabled },
    update: { activeEnvironment: nextEnvironment, enabled: nextEnabled },
  });

  return {
    provider: row.provider,
    activeEnvironment: row.activeEnvironment,
    enabled: row.enabled,
    configured: true,
    updatedAt: row.updatedAt,
  };
}

// ---- Safe reads for the settings UI ---------------------------------------

export async function listCredentialsSafe(
  db: TenantPrismaClient,
): Promise<CredentialSafeView[]> {
  const rows = await db.tenantIntegrationCredential.findMany({
    orderBy: [{ provider: "asc" }, { environment: "asc" }],
    select: SAFE_SELECT,
  });
  return rows.map(toSafeView);
}

export async function getCredentialSafe(
  db: TenantPrismaClient,
  provider: IntegrationProvider,
  environment: IntegrationEnvironment,
): Promise<CredentialSafeView | null> {
  const row = await db.tenantIntegrationCredential.findUnique({
    where: { provider_environment: { provider, environment } },
    select: SAFE_SELECT,
  });
  return row === null ? null : toSafeView(row);
}

// ===========================================================================
// PLATFORM credentials (Task T-A3) — `public.platform_integration_credentials`.
//
// Angaza's OWN credentials, never a tenant's: the SMS and email accounts the
// platform sends password-reset codes and staff invitations from. They are read
// HERE because this module is the system's single decryptor; the platform table has
// no tenant schema behind it, so these functions take no tenant client and there is
// no tenant parameter to abuse.
//
// WHICH ENVIRONMENT IS DERIVED, NOT CONFIGURED: a production deployment reads the
// "production" row and every other deployment reads the "sandbox" row, so a dev or
// test deployment can never send through Angaza's production accounts. Only an
// ACTIVE row is ever decrypted. As with the tenant doors above, each typed accessor
// is called by exactly ONE factory (src/services/notifications/factory.ts) and
// nothing here logs.
// ===========================================================================

export type PlatformCredentialEnvironment = "sandbox" | "production";

export function platformCredentialEnvironment(): PlatformCredentialEnvironment {
  return env.isProduction ? "production" : "sandbox";
}

export class NoActivePlatformCredentialError extends Error {
  readonly provider: PlatformNotificationProviderName;
  readonly environment: PlatformCredentialEnvironment;

  constructor(provider: PlatformNotificationProviderName, environment: PlatformCredentialEnvironment) {
    super(
      `The platform has no ACTIVE ${provider} credential for the "${environment}" environment. Store and activate it in platform_integration_credentials before selecting that provider.`,
    );
    this.name = "NoActivePlatformCredentialError";
    this.provider = provider;
    this.environment = environment;
  }
}

async function getActivePlatformCredentialFields(
  provider: PlatformNotificationProviderName,
): Promise<CredentialFieldMap> {
  const environment = platformCredentialEnvironment();
  const row = await platformDb.platformIntegrationCredential.findFirst({
    where: { provider, environment, status: "ACTIVE" },
  });
  if (row === null) {
    throw new NoActivePlatformCredentialError(provider, environment);
  }
  return decryptFields(row);
}

/** Called only by src/services/notifications/factory.ts (SMS). */
export async function getActiveAfricasTalkingCredentialFields(): Promise<AfricasTalkingCredentialFields> {
  return parseAfricasTalkingCredentialFields(await getActivePlatformCredentialFields("AFRICASTALKING"));
}

/** Called only by src/services/notifications/factory.ts (email). */
export async function getActiveSendgridCredentialFields(): Promise<SendgridCredentialFields> {
  return parseSendgridCredentialFields(await getActivePlatformCredentialFields("SENDGRID"));
}
