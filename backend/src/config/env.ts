import { isIP } from "node:net";
import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function requiredPort(name: string, fallback: string): number {
  const raw = optional(name, fallback);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(
      `Invalid environment variable ${name}: expected a port number between 1 and 65535, got "${raw}"`,
    );
  }
  return parsed;
}

function requiredSecret(name: string, minLength: number): string {
  const value = required(name);
  if (value.length < minLength) {
    throw new Error(
      `Invalid environment variable ${name}: must be at least ${minLength} characters, got ${value.length}.`,
    );
  }
  return value;
}

function positiveInt(name: string, fallback: string): number {
  const raw = optional(name, fallback);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid environment variable ${name}: expected a positive integer, got "${raw}"`,
    );
  }
  return parsed;
}

// AES-256 key material for the per-tenant integration credential store (Task
// 3.4). Supplied base64 or hex, and it MUST decode to exactly 32 bytes — a
// short key is a silent downgrade of every stored secret, so this fails fast at
// load exactly like JWT_SECRET. The key itself is never logged, never returned
// by an API, and never included in an error message.
const CREDENTIAL_KEY_BYTES = 32;

function requiredEncryptionKey(name: string): Buffer {
  const raw = required(name);
  const looksHex = /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0;
  const decoded = looksHex ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (decoded.length !== CREDENTIAL_KEY_BYTES) {
    throw new Error(
      `Invalid environment variable ${name}: must decode (base64 or hex) to exactly ${CREDENTIAL_KEY_BYTES} bytes, got ${decoded.length}. ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  return decoded;
}

export type MpesaProviderName = "simulated" | "daraja";

// ---------------------------------------------------------------------------
// M-Pesa configuration (Task 3.3, made per-tenant by Task 3.4).
//
// WHAT MOVED IN 3.4: the Daraja consumer key / consumer secret / passkey /
// shortcode are NO LONGER process-wide environment variables. They are per
// tenant, encrypted at rest, in that tenant's own
// `tenant_integration_credentials` table, and are resolved per request by
// src/services/mpesa/factory.ts. A process-wide credential set cannot be
// correct in a multi-tenant system: under Option A each tenant's sales settle
// to THAT tenant's own shortcode, never to a shared one.
//
// WHAT STAYS IN ENV: things that are properties of this DEPLOYMENT rather than
// of a tenant — which implementation to construct (MPESA_PROVIDER), the
// unguessable webhook path secret, the simulator delay, and the public origin
// the server builds each tenant's callback URL from.
//
// The Daraja API host is DERIVED from the tenant's active environment
// (SANDBOX -> sandbox.safaricom.co.ke, PRODUCTION -> api.safaricom.co.ke), so
// going live is activating a production credential row and flipping the
// tenant's activeEnvironment — a config action, never a redeploy.
// ---------------------------------------------------------------------------
export interface MpesaConfig {
  readonly provider: MpesaProviderName;
  readonly simDelayMs: number;
  // Unguessable path segment on the public callback URL — the first webhook gate.
  readonly callbackPathSecret: string;
  // Public origin (scheme + host, no trailing slash) that Safaricom can reach.
  // The full per-tenant callback URL is built from it as
  // `<origin>/v1/webhooks/mpesa/<pathSecret>/<tenantSlug>` — server-generated,
  // never taken from a request. Required only under the real provider.
  readonly callbackBaseUrl: string | null;
  // DEV CONVENIENCE ONLY: a shortcode the SIMULATED provider reports when a
  // tenant has no stored credential yet. The real Daraja provider NEVER falls
  // back to it — falling back to a shared shortcode would break Option A.
  readonly devFallbackShortcode: string | null;
}

function mpesaProviderName(): MpesaProviderName {
  const raw = optional("MPESA_PROVIDER", "simulated");
  if (raw !== "simulated" && raw !== "daraja") {
    throw new Error(
      `Invalid environment variable MPESA_PROVIDER: expected "simulated" or "daraja", got "${raw}".`,
    );
  }
  return raw;
}

function optionalOrNull(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value === "" ? null : value;
}

function buildMpesaConfig(): MpesaConfig {
  const provider = mpesaProviderName();
  // The callback path secret is required in BOTH modes — it guards the public
  // webhook regardless of provider.
  const callbackPathSecret = requiredSecret("MPESA_CALLBACK_PATH_SECRET", 16);
  const simDelayMs = positiveInt("MPESA_SIM_DELAY_MS", "1500");

  // Under the real provider the server must be able to build a reachable
  // callback URL; fail fast rather than pushing an STK Safaricom cannot answer.
  const callbackBaseUrl =
    provider === "daraja" ? required("MPESA_CALLBACK_BASE_URL").replace(/\/+$/, "") : null;

  return {
    provider,
    simDelayMs,
    callbackPathSecret,
    callbackBaseUrl,
    devFallbackShortcode: optionalOrNull("MPESA_SHORTCODE"),
  };
}

// ---------------------------------------------------------------------------
// KRA eTIMS configuration (Task 4.1).
//
// WHAT IS IN ENV: only which IMPLEMENTATION to construct, and a dev-only
// simulator switch. Both are properties of the DEPLOYMENT.
//
// WHAT IS NOT, AND NEVER WILL BE: the tenant's TIN, branch id, device serial
// number, communication key or auth token. Those are properties of a TENANT and
// live encrypted in that tenant's own credential store. A process-wide eTIMS
// credential would mean every tenant filing under one PIN — a tax misdeclaration,
// not merely a misconfiguration. There is no env fallback and no shared signer.
// ---------------------------------------------------------------------------
export type EtimsProviderName = "simulated" | "oscu";

export type EtimsSimOutcome = "sign" | "reject" | "offline";

export interface EtimsConfig {
  readonly provider: EtimsProviderName;
  /**
   * DEV-ONLY. Forces every simulated submission to one outcome, for driving a
   * whole scenario without editing request data. Ignored entirely under the real
   * provider. Per-request markers still override it (see simulated-provider.ts).
   */
  readonly simOutcome: EtimsSimOutcome;
}

function etimsProviderName(): EtimsProviderName {
  const raw = optional("ETIMS_PROVIDER", "simulated");
  if (raw !== "simulated" && raw !== "oscu") {
    throw new Error(
      `Invalid environment variable ETIMS_PROVIDER: expected "simulated" or "oscu", got "${raw}".`,
    );
  }
  return raw;
}

function etimsSimOutcome(): EtimsSimOutcome {
  const raw = optional("ETIMS_SIM_OUTCOME", "sign");
  if (raw !== "sign" && raw !== "reject" && raw !== "offline") {
    throw new Error(
      `Invalid environment variable ETIMS_SIM_OUTCOME: expected "sign", "reject" or "offline", got "${raw}".`,
    );
  }
  return raw;
}

function buildEtimsConfig(): EtimsConfig {
  return { provider: etimsProviderName(), simOutcome: etimsSimOutcome() };
}

// ---------------------------------------------------------------------------
// Notifications (Task T-A3).
//
// WHAT IS IN ENV: only which IMPLEMENTATION each channel uses — a property of the
// DEPLOYMENT. Both default to the simulator, which performs no network call.
//
// WHAT IS NOT, AND NEVER WILL BE: an SMS API key, an email API key, a username or a
// sender identity. Those are Angaza's PLATFORM credentials and live encrypted in
// `platform_integration_credentials`, read only through the credential store.
// ---------------------------------------------------------------------------
export type SmsProviderName = "simulated" | "africastalking";
export type EmailProviderName = "simulated" | "sendgrid" | "smtp";

export interface NotificationConfig {
  readonly smsProvider: SmsProviderName;
  readonly emailProvider: EmailProviderName;
}

function smsProviderName(): SmsProviderName {
  const raw = optional("NOTIFICATION_SMS_PROVIDER", "simulated");
  if (raw !== "simulated" && raw !== "africastalking") {
    throw new Error(
      `Invalid environment variable NOTIFICATION_SMS_PROVIDER: expected "simulated" or "africastalking", got "${raw}".`,
    );
  }
  return raw;
}

function emailProviderName(): EmailProviderName {
  const raw = optional("NOTIFICATION_EMAIL_PROVIDER", "simulated");
  if (raw !== "simulated" && raw !== "sendgrid" && raw !== "smtp") {
    throw new Error(
      `Invalid environment variable NOTIFICATION_EMAIL_PROVIDER: expected "simulated", "sendgrid" or "smtp", got "${raw}".`,
    );
  }
  return raw;
}

export type NodeEnvName = "development" | "test" | "production";

function nodeEnvValue(): NodeEnvName {
  const raw = optional("NODE_ENV", "development");
  if (raw !== "development" && raw !== "test" && raw !== "production") {
    throw new Error(
      `Invalid environment variable NODE_ENV: expected "development", "test" or "production", got "${raw}".`,
    );
  }
  return raw;
}

// ---------------------------------------------------------------------------
// /docs access (Task G.3). An interactive explorer for a financial API must not
// be anonymously reachable in production: it advertises every route, every
// field, and gives an attacker a working request builder.
//
// Default: ON outside production, OFF in production. Setting API_DOCS_ENABLED
// explicitly overrides in either direction — so serving docs in production is
// a deliberate, auditable act, never an accident. Even when enabled in
// production, the docs routes require an authenticated session (see server.ts).
// ---------------------------------------------------------------------------
function apiDocsEnabled(nodeEnv: NodeEnvName): boolean {
  const raw = process.env["API_DOCS_ENABLED"];
  if (raw === undefined || raw === "") {
    return nodeEnv !== "production";
  }
  if (raw !== "true" && raw !== "false") {
    throw new Error(
      `Invalid environment variable API_DOCS_ENABLED: expected "true" or "false", got "${raw}".`,
    );
  }
  return raw === "true";
}

// ---------------------------------------------------------------------------
// TRUSTED PROXIES (Task T-B-PROXY). The Next BFF calls this API on the user's behalf and passes
// the user's address in X-Forwarded-For. That header is honoured ONLY from the proxies listed in
// TRUST_PROXY — exact IPs or CIDR ranges, comma-separated — so req.ip (and every rate-limit key)
// is the real client behind the BFF, and nobody else can claim an address. Unset trusts nothing
// (the socket address is the client). "Trust everything" is refused outright: a wildcard, "true",
// or a range that matches every address would let any caller forge its IP and dodge the limits.
// ---------------------------------------------------------------------------
const MATCH_EVERYTHING = new Set(["true", "*", "0.0.0.0/0", "::/0", "all"]);

function isIpOrCidr(value: string): boolean {
  const [address, prefix, extra] = value.split("/");
  if (address === undefined || extra !== undefined) return false;
  const version = isIP(address);
  if (version === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  return bits >= 1 && bits <= (version === 4 ? 32 : 128);
}

export function parseTrustedProxies(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const entries = raw.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  for (const entry of entries) {
    if (MATCH_EVERYTHING.has(entry.toLowerCase())) {
      throw new Error(
        `Invalid environment variable TRUST_PROXY: "${entry}" would trust every address. List the BFF's own address(es) or range(s) instead.`,
      );
    }
    if (!isIpOrCidr(entry)) {
      throw new Error(`Invalid environment variable TRUST_PROXY: "${entry}" is not an IP address or CIDR range.`);
    }
  }
  return entries;
}

/**
 * An optional source-address allowlist (M4.5 W1): exact IPs or CIDR ranges, comma-separated.
 * Unset is an empty list (no check). A match-everything entry is refused, as for TRUST_PROXY.
 */
export function parseIpAllowlist(name: string, raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const entries = raw.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  for (const entry of entries) {
    if (MATCH_EVERYTHING.has(entry.toLowerCase())) {
      throw new Error(`Invalid environment variable ${name}: "${entry}" would admit every address.`);
    }
    if (!isIpOrCidr(entry)) {
      throw new Error(`Invalid environment variable ${name}: "${entry}" is not an IP address or CIDR range.`);
    }
  }
  return entries;
}

/**
 * The web app's public address (Task T-B-INVITE-LINK): invitation messages carry
 * `<APP_BASE_URL>/invite/<code>`. REQUIRED, and https, in production; locally it defaults to the
 * Next.js dev server. A trailing slash is dropped.
 */
export function parseAppBaseUrl(raw: string | undefined, nodeEnv: NodeEnvName): string {
  if (raw === undefined || raw.trim() === "") {
    if (nodeEnv === "production") {
      throw new Error("Missing required environment variable: APP_BASE_URL (the web app address invitation links point to).");
    }
    return "http://localhost:3000";
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`Invalid environment variable APP_BASE_URL: "${raw}" is not a URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Invalid environment variable APP_BASE_URL: it must be an http(s) address.");
  }
  if (nodeEnv === "production" && url.protocol !== "https:") {
    throw new Error("Invalid environment variable APP_BASE_URL: it must be https in production.");
  }
  return url.toString().replace(/\/+$/, "");
}

export interface Env {
  readonly nodeEnv: NodeEnvName;
  readonly isProduction: boolean;
  // Whether /docs and the raw OpenAPI document are served at all.
  readonly apiDocsEnabled: boolean;
  readonly databaseUrl: string;
  readonly port: number;
  readonly host: string;
  readonly corsOrigin: string;
  readonly jwtSecret: string;
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlSeconds: number;
  readonly loginRateLimitMax: number;
  readonly loginRateLimitWindowMs: number;
  // The SENSITIVE rate-limit tier (Task T-A2, src/plugins/security.ts): secret
  // writes and report generation. Per client IP, per route.
  readonly sensitiveRateLimitMax: number;
  readonly sensitiveRateLimitWindowMs: number;
  // 32-byte AES-256-GCM key for the integration credential store. Read ONLY by
  // src/lib/crypto/credential-cipher.ts.
  readonly credentialEncryptionKey: Buffer;
  readonly mpesa: MpesaConfig;
  readonly etims: EtimsConfig;
  readonly notifications: NotificationConfig;
  // How long a password reset code stays usable (Task T-A4).
  readonly passwordResetTtlMinutes: number;
  // How long a staff invitation stays usable (Task T-A5).
  readonly invitationTtlHours: number;
  // The proxies whose X-Forwarded-For is honoured (Task T-B-PROXY). Empty: none.
  readonly trustedProxies: readonly string[];
  // The web app address invitation links point to (Task T-B-INVITE-LINK).
  readonly appBaseUrl: string;
  // Whether the simulated notification provider echoes each message to the console: on in
  // development only — never in production, off in test (T-B-INVITE-LINK).
  readonly notificationSimulatorEcho: boolean;
  // MFA + login challenges (M4.5 W1).
  readonly loginChallengeTtlMinutes: number;
  readonly loginChallengeMaxAttempts: number;
  readonly stepUpTtlSeconds: number;
  // M-Pesa callback source allowlist (M4.5 W1, T-B2): exact IPs or CIDRs Safaricom posts
  // from. Empty: no source check (the path secret and the INITIATED-row match still gate).
  readonly mpesaCallbackAllowlist: readonly string[];
}

const nodeEnv = nodeEnvValue();

export const env: Env = Object.freeze({
  nodeEnv,
  isProduction: nodeEnv === "production",
  apiDocsEnabled: apiDocsEnabled(nodeEnv),
  databaseUrl: required("DATABASE_URL"),
  port: requiredPort("PORT", "4000"),
  host: optional("HOST", "0.0.0.0"),
  corsOrigin: optional("CORS_ORIGIN", "http://localhost:3000"),
  jwtSecret: requiredSecret("JWT_SECRET", 32),
  accessTokenTtlSeconds: positiveInt("ACCESS_TOKEN_TTL_SECONDS", "900"),
  refreshTokenTtlSeconds: positiveInt("REFRESH_TOKEN_TTL_SECONDS", "604800"),
  loginRateLimitMax: positiveInt("LOGIN_RATE_LIMIT_MAX", "5"),
  loginRateLimitWindowMs: positiveInt("LOGIN_RATE_LIMIT_WINDOW_MS", "60000"),
  sensitiveRateLimitMax: positiveInt("SENSITIVE_RATE_LIMIT_MAX", "30"),
  sensitiveRateLimitWindowMs: positiveInt("SENSITIVE_RATE_LIMIT_WINDOW_MS", "60000"),
  credentialEncryptionKey: requiredEncryptionKey("CREDENTIAL_ENCRYPTION_KEY"),
  mpesa: buildMpesaConfig(),
  etims: buildEtimsConfig(),
  notifications: { smsProvider: smsProviderName(), emailProvider: emailProviderName() },
  passwordResetTtlMinutes: positiveInt("PASSWORD_RESET_TTL_MINUTES", "60"),
  invitationTtlHours: positiveInt("INVITATION_TTL_HOURS", "72"),
  trustedProxies: Object.freeze(parseTrustedProxies(process.env["TRUST_PROXY"])),
  appBaseUrl: parseAppBaseUrl(process.env["APP_BASE_URL"], nodeEnv),
  notificationSimulatorEcho: nodeEnv === "development" && process.env["NOTIFICATION_SIMULATOR_ECHO"] !== "false",
  loginChallengeTtlMinutes: positiveInt("LOGIN_CHALLENGE_TTL_MINUTES", "10"),
  loginChallengeMaxAttempts: positiveInt("LOGIN_CHALLENGE_MAX_ATTEMPTS", "5"),
  stepUpTtlSeconds: positiveInt("STEP_UP_TTL_SECONDS", "300"),
  mpesaCallbackAllowlist: Object.freeze(parseIpAllowlist("MPESA_CALLBACK_IP_ALLOWLIST", process.env["MPESA_CALLBACK_IP_ALLOWLIST"])),
});
