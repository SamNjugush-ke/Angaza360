import { render } from "@testing-library/react";
import { vi } from "vitest";
import { DataProvider } from "@/components/providers/data-provider";
import { Settings } from "@/components/settings/settings";
import { LocationProvider } from "@/components/shell/location";
import { ToastProvider } from "@/components/toast/toast";
import type { Role } from "@/lib/auth/landing";
import { cents, json, refusal, type Call } from "./money";

// A fake /v1/settings + /v1/integrations server for the Business setup tests. The profile and
// branding are stored and read back; statutory versions supersede forward (refused, as the API
// does, on a date not after the last posting); integration credentials are kept with their secret
// fields but answered only as SAFE views — status, label, keyRef — exactly as the API answers; and
// pointing a provider at an environment with no ACTIVE credential is refused. Any money that is
// not a shilling string ("2400.00") is refused.

export interface SettingsServer {
  calls: Call[];
  routes: Array<(call: Call) => Response | null>;
  profile: Record<string, unknown>;
  branding: { brandPrimaryColor: string | null; brandLogoUrl: string | null };
  schedules: Array<Record<string, unknown>>;
  /** What the server stored, secrets included — never sent back. */
  stored: Array<{ provider: string; environment: string; fields: Record<string, string>; label: string | null; status: string }>;
  settings: Record<string, { activeEnvironment: string; enabled: boolean; configured: boolean }>;
}

const BANDS = [
  { ordinal: 1, lowerBound: "0", upperBound: "2400000", ratePercent: "10" },
  { ordinal: 2, lowerBound: "2400000", upperBound: "3233300", ratePercent: "25" },
  { ordinal: 3, lowerBound: "3233300", upperBound: null, ratePercent: "30" },
];

export const SEED = {
  id: "sch-1",
  label: "KE-2026-02",
  effectiveFrom: "2026-02-01T00:00:00.000Z",
  effectiveTo: null,
  source: "Income Tax Act; NSSF Act 2013 Year Four",
  verifiedOn: "2026-10-04T00:00:00.000Z",
  notes: null,
  personalRelief: "240000",
  nssfRatePercent: "6",
  nssfLowerLimit: "900000",
  nssfUpperLimit: "10800000",
  shifRatePercent: "2.75",
  shifMinimum: "30000",
  ahlRatePercent: "1.5",
  vatStandardRate: "16",
  vatRateSource: "VAT Act 2013 s.5(2)(b)",
  vatRateVerifiedOn: "2026-10-11T00:00:00.000Z",
  totRatePercent: "3",
  totRateSource: "Income Tax Act s.12C",
  totRateVerifiedOn: "2026-10-11T00:00:00.000Z",
  createdById: null,
  createdAt: "2026-02-01T00:00:00.000Z",
  bands: BANDS,
};

export function installSettingsServer(): SettingsServer {
  const server: SettingsServer = {
    calls: [],
    routes: [],
    profile: { taxRegime: "TURNOVER_TAX", isVatRegistered: false, kraPin: null, legalName: null, addressLine: null, phone: null, email: null, receiptFooter: null, showLogoOnReceipt: true, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" },
    branding: { brandPrimaryColor: null, brandLogoUrl: null },
    schedules: [{ ...SEED }],
    stored: [],
    settings: {},
  };
  const settingOf = (provider: string) => ({ provider, ...(server.settings[provider] ?? { activeEnvironment: "SANDBOX", enabled: false, configured: false }), updatedAt: server.settings[provider] ? "2026-11-10T08:00:00.000Z" : null });
  const safe = (c: SettingsServer["stored"][number]) => ({ id: `cred-${c.provider}-${c.environment}`, provider: c.provider, environment: c.environment, status: c.status, label: c.label, keyRef: "app-v1", lastVerifiedAt: null, createdBy: "u-owner", createdAt: "2026-11-10T08:00:00.000Z", updatedAt: "2026-11-10T08:00:00.000Z" });
  const now = new Date().toISOString();
  const current = () => server.schedules.find((s) => String(s.effectiveFrom) <= now && (s.effectiveTo === null || now < String(s.effectiveTo))) ?? SEED;

  const answer = (call: Call): Response | null => {
    const path = call.url.pathname;
    const body = (call.body ?? {}) as Record<string, unknown>;
    if (path === "/api/v1/locations") return json(200, { data: [] });
    if (path === "/api/v1/settings/business-profile") {
      if (call.method === "PUT") {
        server.profile = { ...server.profile, ...body, isVatRegistered: (body.taxRegime ?? server.profile.taxRegime) === "VAT_REGISTERED", updatedAt: "2026-11-10T09:00:00.000Z" };
      }
      return json(200, server.profile);
    }
    if (path === "/api/v1/settings/branding") {
      if (call.method === "PUT") server.branding = { ...server.branding, ...(body as Partial<SettingsServer["branding"]>) };
      return json(200, server.branding);
    }
    if (path === "/api/v1/settings/statutory-schedules/current") return json(200, current());
    if (path === "/api/v1/settings/statutory-schedules" && call.method === "GET") return json(200, { data: [...server.schedules].reverse(), count: server.schedules.length });
    if (path === "/api/v1/settings/statutory-schedules" && call.method === "POST") {
      const from = String(body.effectiveFrom);
      if (from <= "2026-11-05") return refusal(409, "The new version must take effect after 2026-11-05, the latest transaction posted under KE-2026-02.");
      try {
        for (const key of ["personalRelief", "nssfLowerLimit", "nssfUpperLimit", "shifMinimum"]) cents(String(body[key]));
        for (const band of body.bands as Array<Record<string, string | null>>) {
          cents(String(band.lowerBound));
          if (band.upperBound !== null) cents(String(band.upperBound));
        }
      } catch (error) {
        return refusal(400, (error as Error).message);
      }
      const open = server.schedules.find((s) => s.effectiveTo === null) ?? SEED;
      open.effectiveTo = `${from}T00:00:00.000Z`;
      // Money comes back as cents strings, as the API answers.
      const money = Object.fromEntries(["personalRelief", "nssfLowerLimit", "nssfUpperLimit", "shifMinimum"].map((k) => [k, cents(String(body[k])).toString()]));
      const created = { ...SEED, ...body, ...money, id: `sch-${(server.schedules.length + 1).toString()}`, label: (body.label as string | undefined) ?? `KE-${from}`, effectiveFrom: `${from}T00:00:00.000Z`, effectiveTo: null, createdById: "u-owner", bands: BANDS };
      server.schedules.push(created);
      return json(201, created);
    }
    if (path === "/api/v1/integrations" && call.method === "GET") {
      const data = ["MPESA", "ETIMS", "STRIPE", "SMS"].map((provider) => ({
        provider,
        credentialsSupported: provider === "MPESA" || provider === "ETIMS",
        settings: settingOf(provider),
        credentials: server.stored.filter((c) => c.provider === provider).map(safe),
      }));
      return json(200, { data });
    }
    const put = /^\/api\/v1\/integrations\/([A-Z]+)\/credentials$/.exec(path);
    if (put && call.method === "PUT") {
      const provider = put[1] ?? "";
      const fields = body.fields as Record<string, string>;
      if (provider === "MPESA" && !fields.passkey) return refusal(400, 'MPESA credential is missing required field "passkey" (it must be a non-empty string).');
      const environment = String(body.environment);
      server.stored = server.stored.filter((c) => !(c.provider === provider && c.environment === environment));
      const row = { provider, environment, fields, label: (body.label as string | undefined) ?? null, status: "PENDING" };
      server.stored.push(row);
      return json(200, safe(row));
    }
    const activate = /^\/api\/v1\/integrations\/([A-Z]+)\/credentials\/([A-Z]+)\/activate$/.exec(path);
    if (activate && call.method === "POST") {
      const row = server.stored.find((c) => c.provider === activate[1] && c.environment === activate[2]);
      if (!row) return refusal(404, `No ${activate[1] ?? ""} credential is stored for the ${activate[2] ?? ""} environment; store it before activating.`);
      row.status = "ACTIVE";
      return json(200, safe(row));
    }
    const setting = /^\/api\/v1\/integrations\/([A-Z]+)\/settings$/.exec(path);
    if (setting && call.method === "PUT") {
      const provider = setting[1] ?? "";
      const now = settingOf(provider);
      const environment = (body.activeEnvironment as string | undefined) ?? now.activeEnvironment;
      if (body.activeEnvironment !== undefined && !server.stored.some((c) => c.provider === provider && c.environment === environment && c.status === "ACTIVE")) {
        return refusal(400, `Cannot set ${provider} activeEnvironment to ${environment}: there is no ACTIVE credential for that environment. Store and activate one first.`);
      }
      server.settings[provider] = { activeEnvironment: environment, enabled: (body.enabled as boolean | undefined) ?? now.enabled, configured: true };
      return json(200, settingOf(provider));
    }
    return null;
  };

  document.cookie = "ag_csrf=csrf-token; path=/";
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const call: Call = { method: init.method ?? "GET", url: new URL(input, "http://app.test"), body: typeof init.body === "string" ? JSON.parse(init.body) : undefined };
    server.calls.push(call);
    for (const route of server.routes) {
      const routed = route(call);
      if (routed) return routed;
    }
    return answer(call) ?? json(404, { statusCode: 404, error: "Not Found", message: "unrouted" });
  });
  return server;
}

export function showSettings(role: Role = "MSME_OWNER", initialTab?: string) {
  return render(
    <ToastProvider>
      <DataProvider>
        <LocationProvider enabled={false}>
          <main>
            <Settings role={role} businessName="Nakuru Hardware" initialTab={initialTab} />
          </main>
        </LocationProvider>
      </DataProvider>
    </ToastProvider>,
  );
}
