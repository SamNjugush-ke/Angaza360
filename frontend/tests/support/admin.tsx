import { vi } from "vitest";
import { json, refusal, type Call } from "./money";

// A fake platform-administration server: the application queue (with the live green-gate), batch
// CSV onboarding (a row is RED until its owner email is fixed; commit refused unless every row is
// green), the tenant registry with onboarding and its lifecycle (DEACTIVATED is final), donor
// projects (members PENDING consent; the aggregate counts consented members only), mentor
// invitations, users and the audit log. Platform-only routes refuse anyone else, and the
// SUPER_ADMIN-only ones (approve, commit, onboard, /users writes) refuse a programme officer — 403.

type Row = Record<string, unknown>;
export interface AdminServer {
  /** Who the fake session is (a reviewing officer is recorded by this id). */
  selfId: string;
  /** The application events recorded, per application. */
  events: Record<string, Row[]>;
  calls: Call[];
  routes: Array<(call: Call) => Response | null>;
  applications: Row[];
  tenants: Row[];
  projects: Row[];
  members: Row[];
  csv: string[];
  role: "SUPER_ADMIN" | "PROGRAM_OFFICER";
  users: Row[];
}

const STAMP = "2026-11-10T08:00:00.000Z";
const app = (id: string, businessName: string, over: Row = {}): Row => ({
  id,
  businessName,
  proposedSubdomain: businessName.toLowerCase().replace(/\s+/g, "-"),
  sector: "Retail",
  kraPin: null,
  taxRegime: "TURNOVER_TAX",
  requestedTier: null,
  ownerFullName: `${businessName} Owner`,
  ownerEmail: `owner@${businessName.toLowerCase().replace(/\s+/g, "")}.test`,
  ownerPhone: null,
  ownerNationalId: null,
  status: "SUBMITTED",
  source: "SELF_SERVE",
  formVersion: 2,
  businessStructure: "SOLE_PROPRIETOR",
  registrationNumber: null,
  businessKraPin: null,
  description: null,
  physicalAddress: "Market Street, Nakuru",
  county: "Nakuru",
  permitNumber: null,
  businessPhone: null,
  businessEmail: null,
  reviewerUserId: null,
  reviewStartedAt: null,
  changesRequested: null,
  batchId: null,
  batchRowNumber: null,
  submittedAt: STAMP,
  reviewedById: null,
  reviewedAt: null,
  rejectionReason: null,
  resultingTenantId: null,
  ...over,
});
const tenant = (id: string, name: string, status = "ACTIVE", county: string | null = null): Row => ({ id, name, subdomain: name.toLowerCase().replace(/\s+/g, "-"), businessSector: "Retail", county, businessStructure: null, kraPin: null, taxRegime: "TURNOVER_TAX", status, subscriptionTier: "MWANZO", subscriptionStatus: "TRIALING", createdAt: STAMP, updatedAt: STAMP });

export function installAdminServer(role: AdminServer["role"] = "SUPER_ADMIN"): AdminServer {
  const server: AdminServer = {
    selfId: role === "SUPER_ADMIN" ? "u-admin" : "u-officer",
    events: {},
    calls: [],
    routes: [],
    role,
    applications: [app("a-1", "Mama Mboga Fresh"), app("a-2", "Duka Moja", { kraPin: "P000000001X" })],
    tenants: [tenant("t-1", "Nakuru Hardware", "ACTIVE", "Nakuru"), tenant("t-2", "Thika Agrovet", "ACTIVE", "Kiambu")],
    projects: [{ id: "p-1", code: "GROW-26", name: "Grow Kenya 2026", donor: "Example Foundation", status: "ACTIVE", createdById: "u-officer", createdAt: STAMP, closedAt: null }],
    members: [
      { id: "m-1", projectId: "p-1", tenantId: "t-1", businessName: "Nakuru Hardware", tenantStatus: "ACTIVE", consentStatus: "CONSENTED", consentByUserId: "u-owner", consentAt: STAMP, joinedAt: STAMP },
      { id: "m-2", projectId: "p-1", tenantId: "t-2", businessName: "Thika Agrovet", tenantStatus: "ACTIVE", consentStatus: "PENDING", consentByUserId: null, consentAt: null, joinedAt: STAMP },
    ],
    csv: [],
    users: [
      { id: "u-mentor", email: "mentor@angaza.test", fullName: "Mary Mentor", phone: null, role: "MENTOR", tenantId: null, businessName: null, isActive: true, lastLoginAt: STAMP, createdAt: STAMP },
      { id: "u-coach", email: "coach@angaza.test", fullName: "Chris Coach", phone: null, role: "COACH", tenantId: null, businessName: null, isActive: true, lastLoginAt: null, createdAt: STAMP },
      { id: "u-cash", email: "cashier@nakuru.test", fullName: "Akinyi Cashier", phone: null, role: "CASHIER", tenantId: "t-1", businessName: "Nakuru Hardware", isActive: true, lastLoginAt: null, createdAt: STAMP },
    ],
  };
  const superOnly = () => (server.role === "SUPER_ADMIN" ? null : refusal(403, "Your role does not permit this action."));
  const gate = (a: Row) => {
    const errors = [];
    if (a.kraPin === "P000000001X") errors.push({ field: "kraPin", code: "DUPLICATE", message: "That KRA PIN is already registered." });
    if (String(a.ownerEmail).startsWith("bad")) errors.push({ field: "ownerEmail", code: "FORMAT", message: "Not an email address." });
    if (String(a.businessName ?? "") === "") errors.push({ field: "businessName", code: "REQUIRED", message: "Required." });
    return { status: errors.length ? "RED" : "GREEN", errors, proposedSubdomain: errors.length ? null : String(a.businessName).toLowerCase().replace(/\s+/g, "-") };
  };
  const onboarded = (name: string, email: string) => {
    const t = tenant(`t-${(server.tenants.length + 1).toString()}`, name);
    server.tenants.push(t);
    return { tenant: t, ownerInvitation: { invitation: { id: "inv-o", email, role: "MSME_OWNER", tenantId: t.id, status: "PENDING", expiresAt: STAMP, createdAt: STAMP }, delivery: { email: "SIMULATED", sms: null } } };
  };
  const batchRows = () => server.applications.filter((a) => a.batchId === "b-1" && a.status === "SUBMITTED");
  const preview = () => {
    const rows = batchRows().map((a) => ({ application: a, ...gate(a) }));
    return { batch: { id: "b-1", uploadedById: "u-admin", status: server.applications.some((a) => a.batchId === "b-1" && a.status === "APPROVED") ? "COMMITTED" : "PREVIEW", createdAt: STAMP, committedAt: null }, rows, allGreen: rows.length > 0 && rows.every((r) => r.status === "GREEN") };
  };

  const answer = (call: Call & { raw?: string }): Response | null => {
    const path = call.url.pathname.replace(/^\/api\/v1/, "");
    const body = (call.body ?? {}) as Row;
    const q = call.url.searchParams;
    let x: RegExpExecArray | null;
    if (path === "/locations") return json(200, { data: [] });
    if (path === "/tenant-applications" && call.method === "GET") {
      const data = server.applications.filter((a) => (!q.get("status") || a.status === q.get("status")) && (!q.get("source") || a.source === q.get("source")));
      return json(200, { data });
    }
    if (path === "/tenant-applications/batch/template") return new Response("businessName,ownerFullName,ownerEmail,taxRegime\n", { status: 200, headers: { "content-type": "text/csv" } });
    if (path === "/tenant-applications/batch" && call.method === "POST") {
      server.csv.push(String(call.raw));
      server.applications.push(app("r-1", "Batch One", { source: "BATCH", batchId: "b-1", batchRowNumber: 1 }), app("r-2", "Batch Two", { source: "BATCH", batchId: "b-1", batchRowNumber: 2, ownerEmail: "bad-email" }));
      return json(201, preview());
    }
    if (path === "/tenant-applications/batch/b-1") return json(200, preview());
    if (path === "/tenant-applications/batch/b-1/commit") {
      const denied = superOnly();
      if (denied) return denied;
      const p = preview();
      if (!p.allGreen) return refusal(409, "The batch cannot be committed until every row is green: row 2 (ownerEmail).");
      const done = batchRows().map((a) => {
        a.status = "APPROVED";
        return onboarded(String(a.businessName), String(a.ownerEmail));
      });
      return json(200, { batch: { ...p.batch, status: "COMMITTED", committedAt: STAMP }, alreadyCommitted: false, onboarded: done });
    }
    if ((x = /^\/tenant-applications\/([^/]+)\/documents\/([^/]+)\/view-grant$/.exec(path))) {
      const a = server.applications.find((r) => r.id === x?.[1]);
      if (!a || (server.role !== "SUPER_ADMIN" && a.reviewerUserId !== server.selfId)) return refusal(403, "Only a super-administrator or the reviewing officer may view the ID document.");
      return json(201, { token: `view-${String(x[2])}`, expiresAt: STAMP });
    }
    if ((x = /^\/tenant-applications\/([^/]+)(?:\/(approve|reject|start-review|request-changes|corrections))?$/.exec(path))) {
      const a = server.applications.find((r) => r.id === x?.[1]);
      if (!a) return refusal(404, "No such application.");
      const id = String(a.id);
      const record = (kind: string, message: string | null = null, corrections: Row[] = []) => (server.events[id] = [...(server.events[id] ?? []), { kind, message, corrections, occurredAt: STAMP }]);
      if (!x[2] && call.method === "GET") {
        const open = ["SUBMITTED", "UNDER_REVIEW", "NEEDS_CHANGES"].includes(String(a.status));
        const documents = a.formVersion === 2 && a.source === "SELF_SERVE"
          ? ["FRONT", "BACK"].map((side) => ({ id: `d-${side}`, side, contentType: "image/jpeg", byteSize: 2048, uploadedAt: STAMP, purgedAt: null }))
          : [];
        return json(200, { application: a, validation: open ? gate(a) : null, documents, timeline: server.events[id] ?? [] });
      }
      if (x[2] === "start-review") {
        if (a.status !== "SUBMITTED") return refusal(409, "Only a submitted application can be taken for review.");
        Object.assign(a, { status: "UNDER_REVIEW", reviewerUserId: server.selfId, reviewStartedAt: STAMP });
        record("REVIEW_STARTED");
        return json(200, a);
      }
      if (x[2] === "request-changes") {
        if (a.status !== "UNDER_REVIEW") return refusal(409, "Start the review first.");
        Object.assign(a, { status: "NEEDS_CHANGES", changesRequested: body.message });
        record("CHANGES_REQUESTED", String(body.message));
        return json(200, a);
      }
      if (x[2] === "corrections") {
        if (a.status !== "UNDER_REVIEW") return refusal(409, "Start the review first.");
        const { note, ...changes } = body;
        const corrections = Object.entries(changes).map(([field, to]) => ({ field, from: a[field] ?? null, to }));
        Object.assign(a, changes);
        record("CORRECTED", note === null || note === undefined ? null : String(note), corrections);
        return json(200, a);
      }
      if (!x[2] && call.method === "PATCH") {
        Object.assign(a, body);
        return json(200, { application: a, ...gate(a) });
      }
      if (!x[2] && call.method === "DELETE") {
        server.applications = server.applications.filter((r) => r !== a);
        return new Response(null, { status: 204 });
      }
      if (x[2] === "approve") {
        const denied = superOnly();
        if (denied) return denied;
        if (a.status !== "UNDER_REVIEW") return refusal(409, "Start the review before deciding.");
        if (gate(a).status === "RED") return refusal(409, "The application cannot be approved: kraPin: That KRA PIN is already registered.");
        a.status = "APPROVED";
        return json(200, { application: a, onboarded: onboarded(String(a.businessName), String(a.ownerEmail)) });
      }
      if (x[2] === "reject") {
        if (a.status !== "UNDER_REVIEW") return refusal(409, "Start the review before deciding.");
        Object.assign(a, { status: "REJECTED", rejectionReason: body.reason });
        return json(200, a);
      }
    }
    if (path === "/tenants" && call.method === "GET") return json(200, { data: server.tenants.filter((t) => !q.get("status") || t.status === q.get("status")) });
    if (path === "/tenants/onboard/validate") return json(200, gate(body));
    if (path === "/tenants/onboard") {
      const denied = superOnly();
      if (denied) return denied;
      return json(201, onboarded(String(body.businessName), String(body.ownerEmail)));
    }
    if ((x = /^\/tenants\/([^/]+)\/(suspend|reactivate|deactivate)$/.exec(path))) {
      const t = server.tenants.find((r) => r.id === x?.[1]);
      if (!t) return refusal(404, "No such tenant.");
      const ok = (x[2] === "suspend" && t.status === "ACTIVE") || (x[2] === "reactivate" && t.status === "SUSPENDED") || (x[2] === "deactivate" && t.status !== "DEACTIVATED");
      if (!ok) return refusal(409, `A ${String(t.status)} tenant cannot be ${x[2]}d.`);
      t.status = x[2] === "suspend" ? "SUSPENDED" : x[2] === "reactivate" ? "ACTIVE" : "DEACTIVATED";
      return json(200, t);
    }
    if (path === "/donor-projects" && call.method === "GET") return json(200, { data: server.projects.filter((p) => !q.get("status") || p.status === q.get("status")) });
    if (path === "/donor-projects" && call.method === "POST") {
      const p = { id: "p-2", code: body.code, name: body.name, donor: body.donor, status: "ACTIVE", createdById: "u-admin", createdAt: STAMP, closedAt: null };
      server.projects.push(p);
      return json(201, { project: p, seeded: 0 });
    }
    if ((x = /^\/donor-projects\/([^/]+)(?:\/(close|members|aggregate))?(?:\/([^/]+))?$/.exec(path))) {
      const p = server.projects.find((r) => r.id === x?.[1]);
      if (!p) return refusal(404, "No such project.");
      const members = server.members.filter((m) => m.projectId === p.id);
      if (!x[2]) return json(200, { project: p, members });
      if (x[2] === "close") {
        Object.assign(p, { status: "CLOSED", closedAt: STAMP });
        return json(200, p);
      }
      if (x[2] === "members" && call.method === "POST") {
        const t = server.tenants.find((r) => r.id === body.tenantId);
        const m = { id: `m-${(server.members.length + 1).toString()}`, projectId: p.id, tenantId: body.tenantId, businessName: t?.name ?? "?", tenantStatus: "ACTIVE", consentStatus: "PENDING", consentByUserId: null, consentAt: null, joinedAt: STAMP };
        server.members.push(m);
        return json(201, m);
      }
      if (x[2] === "members" && call.method === "DELETE") {
        server.members = server.members.filter((m) => !(m.projectId === p.id && m.tenantId === x?.[3]));
        return new Response(null, { status: 204 });
      }
      if (x[2] === "aggregate") {
        const consented = members.filter((m) => m.consentStatus === "CONSENTED");
        return json(200, {
          projectId: p.id,
          code: p.code,
          period: { from: "2026-10-01T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z" },
          comparativePeriod: null,
          members: { total: members.length, consented: consented.length, pending: members.filter((m) => m.consentStatus === "PENDING").length, withdrawn: 0, consentedButInactive: 0 },
          businessesIncluded: consented.length,
          totalRevenue: "9145000",
          medianRevenue: "9145000",
          totalNetProfit: "6586429",
          revenueGrowthPct: "12.50",
          consentedMembers: consented.map((m) => ({ tenantId: m.tenantId, businessName: m.businessName, revenue: "9145000", comparativeRevenue: "8128900", netProfit: "6586429" })),
        });
      }
    }
    if (path === "/mentorship/engagements" && call.method === "GET") {
      return json(200, { data: [{ id: "e-old", mentorId: "u-mentor", mentorName: "Mary Mentor", mentorRole: "MENTOR", tenantId: "t-2", businessName: "Thika Agrovet", status: "ENDED" }], count: 1 });
    }
    if (path === "/mentorship/engagements" && call.method === "POST") {
      const t = server.tenants.find((r) => r.id === body.tenantId);
      return json(201, { id: "e-new", mentorId: body.mentorId, mentorName: "Mary Mentor", mentorRole: "MENTOR", tenantId: body.tenantId, businessName: t?.name ?? "?", status: "INVITED", invitedById: "u-admin", consentGivenAt: null, consentByUserId: null, startedAt: null, endedAt: null, endedReason: null, createdAt: STAMP, updatedAt: STAMP });
    }
    if (path === "/users/audit") {
      return json(200, { data: [{ id: "au-1", action: "TENANT_SUSPENDED", actorUserId: "u-admin", actorName: "Angaza Admin", targetUserId: null, targetName: null, tenantId: q.get("tenantId") ?? "t-1", ipAddress: null, metadata: { from: "ACTIVE", to: "SUSPENDED", reason: "Unpaid" }, occurredAt: STAMP }, { id: "au-2", action: "ROLE_CHANGED", actorUserId: "u-owner", actorName: "Wanjiru Owner", targetUserId: "u-cash", targetName: "Akinyi Cashier", tenantId: "t-1", ipAddress: null, metadata: { fromRole: "CASHIER", toRole: "WAREHOUSE_STAFF" }, occurredAt: STAMP }] });
    }
    if (path === "/users/directory") {
      const needle = (q.get("q") ?? "").toLowerCase();
      const data = server.users.filter((u) => (!q.get("role") || u.role === q.get("role")) && (needle === "" || String(u.fullName).toLowerCase().includes(needle) || String(u.email).includes(needle)));
      const skip = Number(q.get("skip") ?? "0");
      return json(200, { data: data.slice(skip, skip + Number(q.get("take") ?? "50")), total: data.length });
    }
    if (path === "/users/invite") {
      const denied = superOnly();
      if (denied) return denied;
      return json(201, { invitation: { id: "inv-1", email: body.email, role: body.role, tenantId: body.tenantId ?? null, status: "PENDING", expiresAt: STAMP, createdAt: STAMP }, delivery: { email: "SIMULATED", sms: null } });
    }
    if ((x = /^\/users\/([^/]+)\/(role|deactivate|reactivate)$/.exec(path))) {
      const denied = superOnly();
      if (denied) return denied;
      const u = server.users.find((r) => r.id === x?.[1]);
      if (!u) return refusal(404, "No such user.");
      if (x[2] === "role") u.role = body.role;
      else u.isActive = x[2] === "reactivate";
      return json(200, u);
    }
    return null;
  };

  document.cookie = "ag_csrf=csrf-token; path=/";
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const text = typeof init.body === "string" ? init.body : undefined;
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    const call: Call & { raw?: string; headers?: Headers } = { method: init.method ?? "GET", url: new URL(input, "http://app.test"), body: parsed, raw: text, headers: new Headers(init.headers) };
    server.calls.push(call);
    for (const route of server.routes) {
      const routed = route(call);
      if (routed) return routed;
    }
    return answer(call) ?? json(404, { statusCode: 404, error: "Not Found", message: "unrouted" });
  });
  return server;
}
