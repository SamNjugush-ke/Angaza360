import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { paths } from "@/lib/api/schema";
import { getJson, sendJson } from "@/lib/api/request";
import type { Role } from "@/lib/auth/landing";

// Business setup: the business profile (tax regime, KRA PIN, receipt identity), branding, the
// statutory schedules and — the owner's alone — the integration credentials. Every rule is the
// server's; this layer only carries values. Money in a response is cents strings and goes back as
// shilling strings; rates are decimal strings, never money. A stored credential's secret fields
// are WRITE-ONLY: the API returns a safe view (status, label, keyRef) and nothing else.

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Body<T> = T extends { requestBody: { content: { "application/json": infer B } } } ? B : never;

export type Profile = Json<paths["/v1/settings/business-profile"]["get"]["responses"][200]>;
export type ProfileUpdate = Body<paths["/v1/settings/business-profile"]["put"]>;
export type TaxRegime = Profile["taxRegime"];
export type Branding = Json<paths["/v1/settings/branding"]["get"]["responses"][200]>;
export type BrandingUpdate = Body<paths["/v1/settings/branding"]["put"]>;
export type Schedule = Json<paths["/v1/settings/statutory-schedules/current"]["get"]["responses"][200]>;
export type ScheduleList = Json<paths["/v1/settings/statutory-schedules"]["get"]["responses"][200]>;
export type SupersedeBody = Body<paths["/v1/settings/statutory-schedules"]["post"]>;
export type IntegrationList = Json<paths["/v1/integrations/"]["get"]["responses"][200]>;
export type ProviderSummary = IntegrationList["data"][number];
export type Provider = ProviderSummary["provider"];
export type Credential = ProviderSummary["credentials"][number];
export type Environment = Credential["environment"];
export type CredentialStatus = Credential["status"];
export type IntegrationSetting = ProviderSummary["settings"];

// ---- Who may do what (the API's guards, routes/settings.ts and routes/integrations.ts) ----

const has = (roles: readonly Role[]) => (role: Role) => roles.includes(role);
export const settingsPermissions = (role: Role) => ({
  /** GET /business-profile and /branding. */
  canRead: has(["MSME_OWNER", "MSME_MANAGER", "ACCOUNTANT", "VIEWER_AUDITOR"])(role),
  /** GET /statutory-schedules and /current. */
  canReadStatutory: has(["MSME_OWNER", "MSME_MANAGER", "ACCOUNTANT"])(role),
  /** Every settings write, and the whole of /v1/integrations. */
  isOwner: role === "MSME_OWNER",
});
export type SettingsPermissions = ReturnType<typeof settingsPermissions>;

// ---- Calls ----

export const fetchProfile = () => getJson<Profile>("/settings/business-profile");
export const saveProfile = (body: ProfileUpdate) => sendJson<Profile>("PUT", "/settings/business-profile", body);
export const fetchBranding = () => getJson<Branding>("/settings/branding");
export const saveBranding = (body: BrandingUpdate) => sendJson<Branding>("PUT", "/settings/branding", body);
export const fetchSchedules = () => getJson<ScheduleList>("/settings/statutory-schedules");
export const fetchCurrentSchedule = () => getJson<Schedule>("/settings/statutory-schedules/current");
export const supersedeSchedule = (body: SupersedeBody) => sendJson<Schedule>("POST", "/settings/statutory-schedules", body);
export const fetchIntegrations = () => getJson<IntegrationList>("/integrations");
export const storeCredential = (provider: Provider, body: { environment: Environment; fields: Record<string, string>; label?: string }) =>
  sendJson<Credential>("PUT", `/integrations/${provider}/credentials`, body);
export const activateCredential = (provider: Provider, environment: Environment) => sendJson<Credential>("POST", `/integrations/${provider}/credentials/${environment}/activate`);
export const saveIntegrationSetting = (provider: Provider, body: { activeEnvironment?: Environment; enabled?: boolean }) =>
  sendJson<IntegrationSetting>("PUT", `/integrations/${provider}/settings`, body);

// ---- Queries ----

export const settingsKeys = {
  all: ["settings"] as const,
  profile: () => ["settings", "profile"] as const,
  branding: () => ["settings", "branding"] as const,
  schedules: () => ["settings", "schedules"] as const,
  current: () => ["settings", "schedules", "current"] as const,
  integrations: () => ["settings", "integrations"] as const,
};

export const useProfile = () => useQuery({ queryKey: settingsKeys.profile(), queryFn: fetchProfile, staleTime: 0 });
export const useBranding = () => useQuery({ queryKey: settingsKeys.branding(), queryFn: fetchBranding, staleTime: 0 });
export const useSchedules = () => useQuery({ queryKey: settingsKeys.schedules(), queryFn: fetchSchedules, staleTime: 0 });
export const useCurrentSchedule = () => useQuery({ queryKey: settingsKeys.current(), queryFn: fetchCurrentSchedule, staleTime: 0, retry: false });
export const useIntegrations = (enabled: boolean) => useQuery({ queryKey: settingsKeys.integrations(), queryFn: fetchIntegrations, enabled, staleTime: 0 });

/**
 * After a settings write. The regime decides which return /tax shows and how future sales post, and
 * the eTIMS switch decides whether a sale can be filed — so the tax and receipt reads go stale too.
 */
export function useInvalidateSettings(): () => Promise<void> {
  const client = useQueryClient();
  return useCallback(async () => {
    await Promise.all([client.invalidateQueries({ queryKey: settingsKeys.all }), client.invalidateQueries({ queryKey: ["etims"] })]);
  }, [client]);
}

// ---- Words ----

export const REGIME_LABEL: Readonly<Record<TaxRegime, string>> = {
  VAT_REGISTERED: "VAT registered",
  TURNOVER_TAX: "Turnover Tax (TOT)",
  EXEMPT: "Exempt",
};
export const REGIME_MEANING: Readonly<Record<TaxRegime, string>> = {
  VAT_REGISTERED: "Charges VAT on standard-rated sales and recovers input VAT. KRA eTIMS & tax shows the VAT return.",
  TURNOVER_TAX: "Charges no VAT; Turnover Tax accrues on every sale. KRA eTIMS & tax shows the TOT position.",
  EXEMPT: "Charges no VAT and accrues no Turnover Tax.",
};

export const PROVIDER_LABEL: Readonly<Record<Provider, string>> = { MPESA: "M-Pesa (Daraja)", ETIMS: "KRA eTIMS (OSCU)", STRIPE: "Stripe", SMS: "SMS" };
export const PROVIDER_PURPOSE: Readonly<Record<Provider, string>> = {
  MPESA: "Lets the till prompt a customer’s phone for payment, settling to the business’s own shortcode.",
  ETIMS: "Files KRA invoices under the business’s own KRA PIN and device.",
  STRIPE: "Card payments.",
  SMS: "The business’s own SMS sender.",
};
export const ENVIRONMENT_LABEL: Readonly<Record<Environment, string>> = { SANDBOX: "Sandbox (testing)", PRODUCTION: "Production (live)" };
export const ENVIRONMENTS: readonly Environment[] = ["SANDBOX", "PRODUCTION"];
export const CREDENTIAL_STATUS_LABEL: Readonly<Record<CredentialStatus, string>> = {
  PENDING: "Stored — not active yet",
  ACTIVE: "Active",
  FAILED: "Failed verification",
  DISABLED: "Disabled",
};

export interface CredentialField {
  name: string;
  label: string;
  secret: boolean;
  required: boolean;
  hint?: string;
}

/**
 * The credential fields each provider's registered shape takes (the backend's
 * provider-schemas.ts). eTIMS's `cmcKey` is NOT asked for: KRA issues it when the device is
 * initialized, and the server writes it back into the encrypted blob itself.
 */
export const CREDENTIAL_FIELDS: Readonly<Partial<Record<Provider, readonly CredentialField[]>>> = {
  MPESA: [
    { name: "consumerKey", label: "Consumer key", secret: true, required: true },
    { name: "consumerSecret", label: "Consumer secret", secret: true, required: true },
    { name: "shortcode", label: "Shortcode (till or paybill)", secret: false, required: true, hint: "Digits only, e.g. 174379." },
    { name: "passkey", label: "Passkey", secret: true, required: true },
    { name: "initiatorName", label: "Initiator name", secret: false, required: false },
    { name: "initiatorPassword", label: "Initiator password", secret: true, required: false },
  ],
  ETIMS: [
    { name: "tin", label: "KRA PIN (TIN)", secret: false, required: true },
    { name: "bhfId", label: "Branch id", secret: false, required: true, hint: "Usually 00 for the head office." },
    { name: "dvcSrlNo", label: "Device serial number", secret: false, required: true },
    { name: "apiBaseUrl", label: "OSCU API address", secret: false, required: true, hint: "The https address KRA gave you for this environment." },
    { name: "authToken", label: "Auth token", secret: true, required: false },
  ],
};

/** The decimal-percentage shape the API accepts for a rate: "16" or "16.00". */
export const RATE = /^\d{1,3}(\.\d{1,2})?$/;
/** A KRA PIN: a letter, nine digits, a letter. */
export const KRA_PIN = /^[A-Z]\d{9}[A-Z]$/;
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const HEX_COLOUR = /^#[0-9A-Fa-f]{6}$/;
