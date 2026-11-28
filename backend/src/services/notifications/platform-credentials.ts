// ===========================================================================
// ANGAZA'S OWN NOTIFICATION CREDENTIALS, MANAGED (M4.5 Wave 5).
//
// A SUPER_ADMIN manages the PLATFORM's SMTP / Africa's Talking / SendGrid credentials from the
// Command Center: store (a rotation — PENDING and UNVERIFIED until activated), activate, deactivate
// and verify, each audited (provider, environment, outcome — never a field value). This is the
// PLATFORM store only: a business's M-Pesa / eTIMS keys are the owner's and no path here, or
// anywhere in the console, can read, activate or verify them.
//
// VERIFY touches the provider and sends nothing: SMTP connects and logs in; SendGrid reads the key's
// scopes; Africa's Talking reads the account. Every outcome is scrubbed of every stored field value
// before it is stored or returned (`scrubSecrets`), so a provider echoing a key back cannot leak it.
// Verifying is idempotent: it changes only the health record.
// ===========================================================================

import { platformDb } from "../../db/platform";
import type { CredentialFieldMap } from "../../lib/crypto/credential-cipher";
import {
  getPlatformCredentialFieldsForVerification,
  listPlatformCredentialsSafe,
  recordPlatformCredentialHealth,
  setPlatformCredentialStatus,
  storePlatformCredential,
  type PlatformCredentialEnvironment,
  type PlatformCredentialSafeView,
} from "../credentials/credential-store";
import {
  parseAfricasTalkingCredentialFields,
  parseSendgridCredentialFields,
  parseSmtpCredentialFields,
  PLATFORM_NOTIFICATION_PROVIDERS,
  type PlatformNotificationProviderName,
} from "../credentials/provider-schemas";
import { scrubSecrets } from "../credentials/scrub";
import { recordAudit } from "../identity/audit";
import { africasTalkingBaseUrl } from "./africastalking-provider";
import { verifySmtpCredentials, type SmtpTransportFactory } from "./smtp-provider";

export const PLATFORM_CREDENTIAL_ENVIRONMENTS = ["sandbox", "production"] as const;

/** What a verify uses to reach the providers. Swappable in tests; nothing else changes it. */
export const probeDeps: { createTransport: SmtpTransportFactory | undefined; fetch: typeof fetch } = {
  createTransport: undefined,
  fetch: (input, init) => fetch(input, init),
};

const TIMEOUT_MS = 10_000;

/** The fields each provider takes, and which are secret (write-only, never shown). */
export const PLATFORM_CREDENTIAL_FIELDS: Readonly<Record<PlatformNotificationProviderName, ReadonlyArray<{ key: string; label: string; secret: boolean; required: boolean }>>> = {
  SMTP: [
    { key: "host", label: "SMTP host", secret: false, required: true },
    { key: "port", label: "Port", secret: false, required: true },
    { key: "secure", label: "Implicit TLS (true on port 465)", secret: false, required: false },
    { key: "username", label: "Username", secret: false, required: true },
    { key: "password", label: "Password", secret: true, required: true },
    { key: "fromEmail", label: "From address", secret: false, required: true },
    { key: "fromName", label: "From name", secret: false, required: false },
  ],
  SENDGRID: [
    { key: "apiKey", label: "API key", secret: true, required: true },
    { key: "fromEmail", label: "From address", secret: false, required: true },
    { key: "fromName", label: "From name", secret: false, required: false },
  ],
  AFRICASTALKING: [
    { key: "username", label: "Username", secret: false, required: true },
    { key: "apiKey", label: "API key", secret: true, required: true },
    { key: "senderId", label: "Sender ID", secret: false, required: false },
  ],
};

async function httpProbe(url: string, headers: Record<string, string>, what: string): Promise<{ ok: boolean; detail: string }> {
  let response: Response;
  try {
    response = await probeDeps.fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return { ok: false, detail: `${what} could not be reached.` };
  }
  if (response.ok) return { ok: true, detail: `${what} accepted the credentials.` };
  if (response.status === 401 || response.status === 403) return { ok: false, detail: `${what} refused the credentials (HTTP ${response.status.toString()}).` };
  return { ok: false, detail: `${what} answered HTTP ${response.status.toString()}.` };
}

async function probe(provider: PlatformNotificationProviderName, fields: CredentialFieldMap): Promise<{ ok: boolean; detail: string }> {
  switch (provider) {
    case "SMTP":
      return verifySmtpCredentials(parseSmtpCredentialFields(fields), probeDeps.createTransport);
    case "SENDGRID": {
      const c = parseSendgridCredentialFields(fields);
      return httpProbe("https://api.sendgrid.com/v3/scopes", { Authorization: `Bearer ${c.apiKey}`, Accept: "application/json" }, "SendGrid");
    }
    case "AFRICASTALKING": {
      const c = parseAfricasTalkingCredentialFields(fields);
      return httpProbe(`${africasTalkingBaseUrl(c.username)}/version1/user?username=${encodeURIComponent(c.username)}`, { apiKey: c.apiKey, Accept: "application/json" }, "Africa's Talking");
    }
    default: {
      const exhaustive: never = provider;
      throw new Error(`Unknown platform provider ${String(exhaustive)}.`);
    }
  }
}

export interface PlatformCredentialSlot {
  provider: PlatformNotificationProviderName;
  environment: PlatformCredentialEnvironment;
  credential: PlatformCredentialSafeView | null;
}

/** Every provider in every environment — a slot with nothing stored reads `credential: null`. */
export async function listPlatformCredentialSlots(): Promise<PlatformCredentialSlot[]> {
  const rows = await listPlatformCredentialsSafe();
  return PLATFORM_NOTIFICATION_PROVIDERS.flatMap((provider) =>
    PLATFORM_CREDENTIAL_ENVIRONMENTS.map((environment) => ({
      provider,
      environment,
      credential: rows.find((r) => r.provider === provider && r.environment === environment) ?? null,
    })),
  );
}

interface Actor {
  userId: string;
  ipAddress: string | null;
}

export async function storeCredential(
  actor: Actor,
  provider: PlatformNotificationProviderName,
  environment: PlatformCredentialEnvironment,
  fields: CredentialFieldMap,
  label: string | null,
): Promise<PlatformCredentialSafeView> {
  return platformDb.$transaction(async (tx) => {
    const view = await storePlatformCredential(tx, { provider, environment, fields, label, actorUserId: actor.userId });
    await recordAudit(tx, { action: "PLATFORM_CREDENTIAL_STORED", actorUserId: actor.userId, targetUserId: null, tenantId: null, ipAddress: actor.ipAddress, metadata: { provider, environment } });
    return view;
  });
}

export async function setCredentialActive(
  actor: Actor,
  provider: PlatformNotificationProviderName,
  environment: PlatformCredentialEnvironment,
  active: boolean,
): Promise<PlatformCredentialSafeView> {
  return platformDb.$transaction(async (tx) => {
    const view = await setPlatformCredentialStatus(tx, provider, environment, active ? "ACTIVE" : "INACTIVE");
    await recordAudit(tx, {
      action: active ? "PLATFORM_CREDENTIAL_ACTIVATED" : "PLATFORM_CREDENTIAL_DEACTIVATED",
      actorUserId: actor.userId,
      targetUserId: null,
      tenantId: null,
      ipAddress: actor.ipAddress,
      metadata: { provider, environment },
    });
    return view;
  });
}

export async function verifyCredential(
  actor: Actor,
  provider: PlatformNotificationProviderName,
  environment: PlatformCredentialEnvironment,
  now: Date = new Date(),
): Promise<{ ok: boolean; detail: string; credential: PlatformCredentialSafeView }> {
  const fields = await getPlatformCredentialFieldsForVerification(provider, environment);
  let outcome: { ok: boolean; detail: string };
  try {
    outcome = await probe(provider, fields);
  } catch {
    // A stored blob that no longer parses (a shape change) is a failing credential, not a crash.
    outcome = { ok: false, detail: "The stored credential is incomplete for this provider. Store it again." };
  }
  const detail = scrubSecrets(outcome.detail, Object.values(fields));
  const credential = await platformDb.$transaction(async (tx) => {
    const view = await recordPlatformCredentialHealth(tx, provider, environment, { ok: outcome.ok, detail, at: now });
    await recordAudit(tx, { action: "PLATFORM_CREDENTIAL_VERIFIED", actorUserId: actor.userId, targetUserId: null, tenantId: null, ipAddress: actor.ipAddress, metadata: { provider, environment, ok: outcome.ok } });
    return view;
  });
  return { ok: outcome.ok, detail, credential };
}
