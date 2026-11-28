import { json, refusal, type Call } from "./money";
import type { AdminServer } from "./admin";

// THE COMMAND CENTER'S FAKE SERVER (M4.5 W5), layered on the admin fake (installAdminServer): the
// overview aggregate (computed from the fake's OWN tenants and applications, so a tile reconciles to
// its detail screen), the integration-health mirror, the jobs registry and its console run (a
// fresh STEP-UP required; the same idempotency key returns the same run), Angaza's platform
// notification credentials (SUPER_ADMIN only; NO response ever carries a stored value — every
// stored value is kept here so a test can search every response for it), support-access grants
// (each snapshot / profile view appends an access-log entry; a revoked grant reads as 404), the
// business users directory and the platform report library.

type Row = Record<string, unknown>;
type ConsoleCall = Call & { raw?: string; headers?: Headers };

const STAMP = "2026-11-17T06:00:00.000Z";

export interface ConsoleState {
  steppedUp: boolean;
  runs: Row[];
  credentials: Row[];
  /** Every value ever stored through PUT, so a test can prove none comes back. */
  storedSecrets: string[];
  grants: Row[];
  grantLog: Record<string, Row[]>;
  health: Row[];
  responses: string[];
  exports: Row[];
  actedAs: string | null;
}

const JOBS = [
  { name: "etims-retry", description: "Retries queued eTIMS invoices.", suggestedSchedule: "every 15 minutes" },
  { name: "expire-tokens", description: "Expires invitations and codes.", suggestedSchedule: "hourly" },
  { name: "mpesa-reconcile", description: "Asks Safaricom about unanswered prompts.", suggestedSchedule: "every 10 minutes" },
];

export function installConsole(server: AdminServer): ConsoleState {
  const state: ConsoleState = {
    steppedUp: false,
    runs: [
      { id: "run-1", jobName: "etims-retry", trigger: "SCHEDULER", idempotencyKey: "etims-retry:2026-11-17T05:45", requestedBy: null, status: "SUCCEEDED", attempts: 1, summary: { retried: 2 }, error: null, startedAt: "2026-11-17T05:45:00.000Z", finishedAt: "2026-11-17T05:45:02.000Z" },
      { id: "run-2", jobName: "mpesa-reconcile", trigger: "SCHEDULER", idempotencyKey: "mpesa-reconcile:2026-11-17T05:50", requestedBy: null, status: "FAILED", attempts: 3, summary: null, error: "Error: Safaricom unreachable (after 3 attempts)", startedAt: "2026-11-17T05:50:00.000Z", finishedAt: "2026-11-17T05:50:09.000Z" },
    ],
    credentials: [],
    storedSecrets: [],
    grants: [],
    grantLog: {},
    health: [
      { tenantId: "t-1", businessName: "Nakuru Hardware", provider: "MPESA", environment: "SANDBOX", status: "HEALTHY", lastCheckAt: STAMP, lastVerifiedAt: STAMP, lastError: null },
      { tenantId: "t-2", businessName: "Thika Agrovet", provider: "ETIMS", environment: "SANDBOX", status: "FAILING", lastCheckAt: STAMP, lastVerifiedAt: null, lastError: "KRA refused the device serial." },
    ],
    responses: [],
    exports: [],
    actedAs: null,
  };
  const superOnly = () => (server.role === "SUPER_ADMIN" ? null : refusal(403, "Your role does not permit this action."));
  const needStepUp = () => (state.steppedUp ? null : json(403, { statusCode: 403, error: "StepUpRequired", message: "Confirm it is you: enter a fresh authenticator code, then try again." }));
  const lastRun = (name: string) => state.runs.filter((r) => r.jobName === name).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0] ?? null;
  const safe = (c: Row) => Object.fromEntries(Object.entries(c).filter(([key]) => key !== "fields"));
  const record = (response: Response) => {
    void response.clone().text().then((t) => state.responses.push(t));
    return response;
  };
  const grantView = (g: Row) => ({ ...g, state: g.revokedAt ? "REVOKED" : "LIVE" });

  const route = (call: ConsoleCall): Response | null => {
    if (call.url.pathname === "/api/act-as") {
      state.actedAs = call.method === "DELETE" ? null : ((call.body as { tenantId?: string } | null)?.tenantId ?? null);
      return json(200, { ok: true });
    }
    const path = call.url.pathname.replace(/^\/api\/v1/, "");
    const q = call.url.searchParams;
    const body = (call.body ?? {}) as Row;
    let x: RegExpExecArray | null;

    if (path === "/platform-reports/overview") {
      const byStatus = (rows: Row[], key: string) => rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [String(r[key])]: (acc[String(r[key])] ?? 0) + 1 }), {});
      const apps = server.applications.filter((a) => a.status !== "DRAFT");
      const appsByStatus = byStatus(apps, "status");
      const awaiting = (appsByStatus.SUBMITTED ?? 0) + (appsByStatus.UNDER_REVIEW ?? 0);
      return record(
        json(200, {
          generatedAt: STAMP,
          businesses: { total: server.tenants.length, byStatus: byStatus(server.tenants, "status"), byTier: byStatus(server.tenants, "subscriptionTier") },
          applications: { byStatus: appsByStatus, open: awaiting + (appsByStatus.NEEDS_CHANGES ?? 0), awaitingStaff: awaiting, oldestAwaitingSince: awaiting > 0 ? "2026-11-10T08:00:00.000Z" : null, oldestAwaitingDays: awaiting > 0 ? 6 : null },
          users: { activeAccounts: 40, inactiveAccounts: 3, signedInLast30Days: 30, platformStaff: 4 },
          integrations: {
            businesses: [
              { provider: "ETIMS", healthy: 0, failing: state.health.filter((h) => h.provider === "ETIMS" && h.status === "FAILING").length },
              { provider: "MPESA", healthy: state.health.filter((h) => h.provider === "MPESA" && h.status === "HEALTHY").length, failing: 0 },
            ],
            platform: state.credentials.map((c) => ({ provider: c.provider, environment: c.environment, status: c.status, healthStatus: c.healthStatus, lastHealthCheckAt: c.lastHealthCheckAt })),
          },
          jobs: { failedLast24h: state.runs.filter((r) => r.status === "FAILED").length, list: JOBS.map((j) => ({ name: j.name, suggestedSchedule: j.suggestedSchedule, lastStatus: lastRun(j.name)?.status ?? null, lastStartedAt: lastRun(j.name)?.startedAt ?? null, lastError: lastRun(j.name)?.error ?? null, failedLast24h: state.runs.filter((r) => r.jobName === j.name && r.status === "FAILED").length })) },
          recentActivity: [
            { id: "ev-1", action: "TENANT_SUSPENDED", actorUserId: "u-admin", targetUserId: null, tenantId: "t-2", metadata: {}, occurredAt: STAMP, actorName: "Ada Admin", targetName: null },
            { id: "ev-2", action: "USER_INVITED", actorUserId: "u-officer", targetUserId: "u-cash", tenantId: "t-1", metadata: {}, occurredAt: STAMP, actorName: "Otieno Officer", targetName: "Akinyi Cashier" },
          ],
        }),
      );
    }
    if (path === "/tenants/integration-health") {
      return record(json(200, { data: state.health.filter((h) => (!q.get("tenantId") || h.tenantId === q.get("tenantId")) && (!q.get("status") || h.status === q.get("status"))) }));
    }
    if ((x = /^\/tenants\/([^/]+)$/.exec(path)) && call.method === "GET" && x[1] !== "integration-health") {
      const t = server.tenants.find((r) => r.id === x?.[1]);
      return t ? json(200, t) : refusal(404, "No such tenant.");
    }
    if (path === "/users/directory") {
      const data = server.users.filter((u) => !q.get("tenantId") || u.tenantId === q.get("tenantId"));
      return json(200, { data, pagination: { total: data.length, take: 100, skip: 0 } });
    }
    if (path === "/auth/mfa/step-up" && call.method === "POST") {
      if (body.code !== "123456") return refusal(401, "That code is not right.");
      state.steppedUp = true;
      return json(200, { stepUpAt: STAMP });
    }

    // ---- jobs ----
    if (path === "/jobs") return json(200, { data: JOBS.map((j) => ({ ...j, lastRun: lastRun(j.name) })) });
    if (path === "/jobs/runs") {
      const data = state.runs.filter((r) => (!q.get("jobName") || r.jobName === q.get("jobName")) && (!q.get("status") || r.status === q.get("status")));
      return json(200, { data: [...data].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))) });
    }
    if ((x = /^\/jobs\/([^/]+)\/run$/.exec(path)) && call.method === "POST") {
      const denied = superOnly() ?? needStepUp();
      if (denied) return denied;
      const key = call.headers?.get("idempotency-key");
      if (!key) return refusal(400, "An idempotency-key header is required.");
      const existing = state.runs.find((r) => r.idempotencyKey === `console:${key}`);
      if (existing) return json(200, existing);
      if (!JOBS.some((j) => j.name === x?.[1])) return refusal(404, "No such job.");
      const run = { id: `run-${(state.runs.length + 1).toString()}`, jobName: x[1], trigger: "CONSOLE", idempotencyKey: `console:${key}`, requestedBy: server.selfId, status: x[1] === "mpesa-reconcile" ? "FAILED" : "SUCCEEDED", attempts: x[1] === "mpesa-reconcile" ? 3 : 1, summary: x[1] === "mpesa-reconcile" ? null : { invitationsExpired: 0 }, error: x[1] === "mpesa-reconcile" ? "Error: Safaricom unreachable (after 3 attempts)" : null, startedAt: "2026-11-17T06:30:00.000Z", finishedAt: "2026-11-17T06:30:01.000Z" };
      state.runs.push(run);
      return json(200, run);
    }

    // ---- platform credentials (SUPER_ADMIN only) ----
    if (path === "/platform-credentials" || path === "/platform-credentials/") {
      const denied = superOnly();
      if (denied) return denied;
      const slots = ["AFRICASTALKING", "SENDGRID", "SMTP"].flatMap((provider) => ["production", "sandbox"].map((environment) => ({ provider, environment, credential: (() => { const c = state.credentials.find((r) => r.provider === provider && r.environment === environment); return c ? safe(c) : null; })() })));
      return record(
        json(200, {
          data: slots,
          fields: {
            SMTP: [
              { key: "host", label: "SMTP host", secret: false, required: true },
              { key: "port", label: "Port", secret: false, required: true },
              { key: "username", label: "Username", secret: false, required: true },
              { key: "password", label: "Password", secret: true, required: true },
              { key: "fromEmail", label: "From address", secret: false, required: true },
            ],
            SENDGRID: [
              { key: "apiKey", label: "API key", secret: true, required: true },
              { key: "fromEmail", label: "From address", secret: false, required: true },
            ],
            AFRICASTALKING: [
              { key: "username", label: "Username", secret: false, required: true },
              { key: "apiKey", label: "API key", secret: true, required: true },
            ],
          },
          activeEnvironment: "sandbox",
        }),
      );
    }
    if ((x = /^\/platform-credentials\/([A-Z]+)\/(sandbox|production)(?:\/(activate|deactivate|verify))?$/.exec(path))) {
      const denied = superOnly();
      if (denied) return denied;
      const [, provider, environment, action] = x;
      if (!["SMTP", "SENDGRID", "AFRICASTALKING"].includes(provider ?? "")) return refusal(400, "Unknown provider.");
      const found = state.credentials.find((r) => r.provider === provider && r.environment === environment);
      if (call.method === "PUT") {
        const step = needStepUp();
        if (step) return step;
        const fields = (body.fields ?? {}) as Record<string, string>;
        state.storedSecrets.push(...Object.values(fields));
        const row = { id: `cred-${String(provider)}-${String(environment)}`, provider, environment, status: "PENDING", label: body.label ?? null, keyRef: "app-v1", healthStatus: "UNVERIFIED", lastHealthCheckAt: null, lastHealthError: null, lastVerifiedAt: null, updatedById: server.selfId, createdAt: STAMP, updatedAt: STAMP, fields };
        state.credentials = state.credentials.filter((r) => r !== found).concat(row);
        return record(json(200, safe(row)));
      }
      if (!found) return refusal(404, `No ${String(provider)} credential is stored for the "${String(environment)}" environment.`);
      if (action === "verify") {
        found.healthStatus = "HEALTHY";
        found.lastHealthCheckAt = STAMP;
        found.lastVerifiedAt = STAMP;
        return record(json(200, { ok: true, detail: "Connected and signed in to the SMTP server.", credential: safe(found) }));
      }
      const step = needStepUp();
      if (step) return step;
      const target = action === "activate" ? "ACTIVE" : "INACTIVE";
      if (found.status === target) return refusal(409, `The credential is already ${target.toLowerCase()}.`);
      found.status = target;
      return record(json(200, safe(found)));
    }

    // ---- support access ----
    if (path === "/support-access/grants" && call.method === "GET") {
      return json(200, { data: state.grants.filter((g) => !q.get("tenantId") || g.tenantId === q.get("tenantId")).map(grantView) });
    }
    if (path === "/support-access/grants" && call.method === "POST") {
      const denied = superOnly() ?? needStepUp();
      if (denied) return denied;
      const tenant = server.tenants.find((t) => t.id === body.tenantId);
      const grant = { id: `g-${(state.grants.length + 1).toString()}`, adminUserId: server.selfId, adminName: "Ada Admin", tenantId: body.tenantId, businessName: tenant?.name ?? null, createdById: server.selfId, scope: body.scope, reason: body.reason, caseRef: body.caseRef ?? null, purpose: null, grantedAt: STAMP, expiresAt: "2026-11-17T07:00:00.000Z", revokedAt: null, revokedById: null, revokeReason: null, ownerNotifiedAt: STAMP, accessCount: 0 };
      state.grants.push(grant);
      state.grantLog[grant.id] = [];
      return json(201, { grant: grantView(grant), ownerNotifications: [{ to: "owner@nakuru.test", status: "SIMULATED" }] });
    }
    if ((x = /^\/support-access\/grants\/([^/]+)(?:\/(revoke|access-log|snapshot|business-profile))?$/.exec(path))) {
      const g = state.grants.find((r) => r.id === x?.[1]);
      if (!g || (g.revokedAt && (x[2] === "snapshot" || x[2] === "business-profile"))) return refusal(404, "No such live support grant.");
      if (x[2] === "revoke") {
        g.revokedAt = STAMP;
        g.revokedById = server.selfId;
        g.revokeReason = body.reason ?? null;
        return json(200, grantView(g));
      }
      if (x[2] === "access-log") return json(200, { entries: state.grantLog[String(g.id)] ?? [], intact: true });
      if (x[2] === "snapshot" || x[2] === "business-profile") {
        const log = state.grantLog[String(g.id)] ?? [];
        log.push({ seq: log.length + 1, resource: x[2], access: "READ", at: STAMP, hash: `h${(log.length + 1).toString()}` });
        state.grantLog[String(g.id)] = log;
        g.accessCount = log.length;
        if (x[2] === "snapshot") return json(200, { businessName: g.businessName, period: { from: "2026-11-01", to: "2026-11-17" }, revenue: "9145000", netProfit: "6586429" });
        return json(200, { businessName: g.businessName, taxRegime: "TURNOVER_TAX", kraPin: "P051111111N", legalName: "Nakuru Hardware Ltd", addressLine: "Market Street", phone: null, email: null, receiptFooter: null });
      }
      return json(200, grantView(g));
    }

    // ---- the platform report library ----
    if (path === "/platform-reports" || path === "/platform-reports/") {
      return json(200, {
        data: [
          { id: "businesses", title: "Businesses", description: "Every business on the platform.", category: "platform", sensitive: false, filters: [{ key: "status", label: "Status", type: "select", options: [{ value: "ACTIVE", label: "active" }, { value: "SUSPENDED", label: "suspended" }] }, { key: "q", label: "Name contains", type: "search" }] },
          { id: "donor-cohort", title: "Donor programme figures", description: "Consented members only.", category: "programmes", sensitive: true, filters: [] },
        ],
      });
    }
    if ((x = /^\/platform-reports\/(businesses|donor-cohort)(\/export)?$/.exec(path))) {
      const status = q.get("status");
      const rows = server.tenants.filter((t) => !status || t.status === status).filter((t) => !q.get("q") || String(t.name).toLowerCase().includes(String(q.get("q")).toLowerCase()));
      if (x[2]) {
        state.exports.push({ report: x[1], format: q.get("format"), filters: Object.fromEntries([...q.entries()].filter(([k]) => k !== "format")) });
        return new Response(`name\n${rows.map((r) => String(r.name)).join("\n")}`, { status: 200, headers: { "content-type": "text/csv", "content-disposition": `attachment; filename="angaza360-${String(x[1])}.csv"` } });
      }
      return json(200, {
        reportId: x[1],
        title: x[1] === "businesses" ? "Businesses" : "Donor programme figures",
        brand: { name: "Angaza360", color: null, kraPin: null },
        period: null,
        filters: status ? [{ label: "Status", value: status.toLowerCase() }] : [],
        generatedAt: STAMP,
        sections: [{ name: "Businesses", columns: [{ key: "name", header: "Business", kind: "text", total: false }], rows: rows.map((r) => ({ name: r.name })), totals: null, totalRows: rows.length }],
      });
    }
    if (path === "/platform-reports/exports") return json(200, { data: [] });
    return null;
  };
  server.routes.unshift(route as (call: Call) => Response | null);
  return state;
}
