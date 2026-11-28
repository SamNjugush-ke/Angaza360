import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { DataProvider } from "@/components/providers/data-provider";
import { LocationProvider } from "@/components/shell/location";
import { ToastProvider } from "@/components/toast/toast";
import { cents, json, refusal, type Call } from "./money";

// A fake /v1/mentorship + /v1/donor-projects (owner side) server. It holds the privacy model the
// way the API does: a business's figures (snapshot, dashboard, a KPI's actual, the cohort) are
// readable ONLY through an ACTIVE engagement, every such read appends to that engagement's access
// log, and anything else is the same plain 404. The owner consents or declines an INVITED
// engagement, ends one, completes their own action items, and reads the log. Donor memberships move
// PENDING / WITHDRAWN → CONSENTED and back. Money must arrive as shilling strings.

type Row = Record<string, unknown>;
export interface MentorshipServer {
  calls: Call[];
  routes: Array<(call: Call) => Response | null>;
  engagements: Row[];
  goals: Row[];
  indicators: Row[];
  items: Row[];
  sessions: Row[];
  log: Row[];
  memberships: Row[];
  membershipLog: Row[];
}

const engagement = (id: string, businessName: string, status: string, over: Row = {}): Row => ({
  id,
  mentorId: "u-mentor",
  mentorName: "Mary Mentor",
  mentorRole: "MENTOR",
  tenantId: `t-${id}`,
  businessName,
  status,
  invitedById: "u-admin",
  consentGivenAt: status === "INVITED" ? null : "2026-10-01T08:00:00.000Z",
  consentByUserId: status === "INVITED" ? null : "u-owner",
  startedAt: status === "INVITED" ? null : "2026-10-01T08:00:00.000Z",
  endedAt: status === "ENDED" ? "2026-10-20T08:00:00.000Z" : null,
  endedReason: status === "ENDED" ? "Programme finished" : null,
  createdAt: "2026-09-28T08:00:00.000Z",
  updatedAt: "2026-10-01T08:00:00.000Z",
  ...over,
});

const PERIOD = { from: "2026-11-01T00:00:00.000Z", to: "2026-11-10T00:00:00.000Z" };
const STAMP = "2026-11-10T09:00:00.000Z";

export function installMentorshipServer(): MentorshipServer {
  const server: MentorshipServer = {
    calls: [],
    routes: [],
    engagements: [engagement("e-1", "Nakuru Hardware", "ACTIVE"), engagement("e-2", "Thika Agrovet", "INVITED"), engagement("e-3", "Kisumu Traders", "ENDED")],
    goals: [{ id: "g-1", engagementId: "e-1", title: "Grow monthly revenue", targetValue: "15000000", targetMetric: "Monthly revenue", targetDate: "2026-12-31T00:00:00.000Z", status: "ON_TRACK", createdById: "u-mentor", createdAt: STAMP, updatedAt: STAMP }],
    indicators: [{ id: "k-1", engagementId: "e-1", name: "Monthly revenue", sourceKey: "MONTHLY_REVENUE", kind: "AMOUNT", targetAmount: "10000000", targetRate: null, note: null, createdById: "u-mentor", createdAt: STAMP }],
    items: [
      { id: "a-1", engagementId: "e-1", title: "Reconcile the till weekly", responsibleParty: "ENTREPRENEUR", dueDate: "2026-11-20T00:00:00.000Z", status: "OPEN", completedAt: null, completedById: null, createdById: "u-mentor", createdAt: STAMP, updatedAt: STAMP },
      { id: "a-2", engagementId: "e-1", title: "Send pricing template", responsibleParty: "MENTOR", dueDate: null, status: "OPEN", completedAt: null, completedById: null, createdById: "u-mentor", createdAt: STAMP, updatedAt: STAMP },
    ],
    sessions: [{ id: "s-1", engagementId: "e-1", sessionDate: "2026-11-03T00:00:00.000Z", summary: "Reviewed October sales", observations: "Margins thin on cement", commitments: "Reprice cement", createdById: "u-mentor", createdAt: STAMP }],
    log: [],
    memberships: [
      { id: "m-1", projectId: "p-1", tenantId: "t-e-1", businessName: "Nakuru Hardware", tenantStatus: "ACTIVE", consentStatus: "PENDING", consentByUserId: null, consentAt: null, joinedAt: STAMP },
    ],
    membershipLog: [{ id: "dl-1", projectId: "p-1", readerUserId: "u-officer", readerName: "Grace Officer", resource: "aggregate", viewedAt: STAMP }],
  };
  const find = (id: string) => server.engagements.find((e) => e.id === id);
  const active = (id: string) => {
    const e = find(id);
    return e && e.status === "ACTIVE" ? e : null;
  };
  const notFound = () => refusal(404, "No such engagement.");
  const read = (e: Row, resource: string) => server.log.unshift({ id: `l-${(server.log.length + 1).toString()}`, engagementId: e.id, mentorId: e.mentorId, mentorName: e.mentorName, tenantId: e.tenantId, resource, viewedAt: STAMP });
  const actualOf = (k: Row) => ({ actualAmount: k.kind === "AMOUNT" ? "9145000" : null, actualRate: k.kind === "RATE" ? "69.29" : null, unavailableReason: null });
  const of = (rows: Row[], engagementId: string) => rows.filter((r) => r.engagementId === engagementId);

  const answer = (call: Call): Response | null => {
    const path = call.url.pathname;
    const body = (call.body ?? {}) as Record<string, unknown>;
    const m = /^\/api\/v1\/mentorship\/(.+)$/.exec(path);
    if (path === "/api/v1/locations") return json(200, { data: [] });
    if (path === "/api/v1/donor-projects/my-memberships") {
      return json(200, { data: server.memberships.map((membership) => ({ membership, project: { id: "p-1", code: "GROW-26", name: "Grow Kenya 2026", donor: "Example Foundation", status: "ACTIVE", createdById: "u-officer", createdAt: STAMP, closedAt: null } })) });
    }
    const mem = /^\/api\/v1\/donor-projects\/my-memberships\/([^/]+)\/(consent|withdraw|access-log)$/.exec(path);
    if (mem) {
      const row = server.memberships.find((x) => x.id === mem[1]);
      if (!row) return refusal(404, "No such membership.");
      if (mem[2] === "access-log") return json(200, { data: server.membershipLog });
      if (mem[2] === "consent") {
        if (row.consentStatus === "CONSENTED") return refusal(409, "Consent is already given.");
        Object.assign(row, { consentStatus: "CONSENTED", consentByUserId: "u-owner", consentAt: STAMP });
      } else {
        if (row.consentStatus !== "CONSENTED") return refusal(409, "There is no consent to withdraw.");
        Object.assign(row, { consentStatus: "WITHDRAWN" });
      }
      return json(200, row);
    }
    if (!m) return null;
    const rest = m[1] ?? "";
    let x: RegExpExecArray | null;
    if (rest === "engagements" && call.method === "GET") return json(200, { data: server.engagements, count: server.engagements.length });
    if (rest === "my-engagements") return json(200, { data: server.engagements, count: server.engagements.length });
    if (rest === "cohort") {
      const members = server.engagements.filter((e) => e.status === "ACTIVE").map((e) => {
        read(e, "cohort");
        return { engagement: e, period: PERIOD, revenue: "9145000", cashPosition: "-61253000", grossMarginPct: "69.29", grossMarginUnavailableReason: null, openActionItems: of(server.items, String(e.id)).filter((i) => i.status === "OPEN").length };
      });
      return json(200, { members, computedAt: STAMP });
    }
    if ((x = /^my-engagements\/([^/]+)$/.exec(rest))) {
      const e = find(x[1] ?? "");
      if (!e) return notFound();
      const items = of(server.items, String(e.id));
      return json(200, { engagement: e, goals: of(server.goals, String(e.id)), indicators: of(server.indicators, String(e.id)), actionItems: { open: items.filter((i) => i.status === "OPEN"), closed: items.filter((i) => i.status !== "OPEN") }, sessions: of(server.sessions, String(e.id)), accessLog: server.log.filter((l) => l.engagementId === e.id) });
    }
    if ((x = /^my-action-items\/([^/]+)$/.exec(rest))) {
      const item = server.items.find((i) => i.id === x?.[1]);
      if (!item) return refusal(404, "No such action item.");
      if (item.responsibleParty !== "ENTREPRENEUR") return refusal(403, "Only an action item assigned to the business owner can be completed here.");
      if (item.status !== "OPEN") return refusal(409, "The action item is not open.");
      Object.assign(item, { status: "DONE", completedAt: STAMP, completedById: "u-owner" });
      return json(200, item);
    }
    if ((x = /^engagements\/([^/]+)\/(consent|decline|end|access-log|snapshot|dashboard|goals|indicators|action-items|sessions)$/.exec(rest))) {
      const e = find(x[1] ?? "");
      if (!e) return notFound();
      const what = x[2];
      if (what === "consent") {
        if (e.status !== "INVITED") return refusal(409, `The engagement is ${String(e.status)}; only an INVITED engagement can be consented to.`);
        Object.assign(e, { status: "ACTIVE", consentGivenAt: STAMP, consentByUserId: "u-owner", startedAt: STAMP });
        return json(200, e);
      }
      if (what === "decline") {
        if (e.status !== "INVITED") return refusal(409, "Only an INVITED engagement can be declined.");
        Object.assign(e, { status: "ENDED", endedAt: STAMP, endedReason: "Declined by the owner" });
        return json(200, e);
      }
      if (what === "end") {
        if (e.status === "ENDED") return refusal(409, "The engagement has already ended.");
        Object.assign(e, { status: "ENDED", endedAt: STAMP, endedReason: (body.reason as string | undefined) ?? null });
        return json(200, e);
      }
      if (what === "access-log") return json(200, { data: server.log.filter((l) => l.engagementId === e.id), count: 0 });
      if (!active(String(e.id))) return notFound();
      if (what === "snapshot") {
        read(e, "snapshot");
        return json(200, { engagementId: e.id, tenantId: e.tenantId, businessName: e.businessName, period: PERIOD, revenue: "9145000", grossProfit: "6336800", netProfit: "6586429", cashPosition: "-61253000" });
      }
      if (what === "dashboard") {
        const indicators = of(server.indicators, String(e.id));
        if (indicators.length > 0) read(e, `dashboard:${indicators.map((k) => String(k.sourceKey)).join(",")}`);
        const items = of(server.items, String(e.id));
        return json(200, {
          engagement: e,
          period: PERIOD,
          indicators: indicators.map((k) => ({ ...k, ...actualOf(k), standing: "OFF_TARGET" })),
          goals: of(server.goals, String(e.id)),
          actionItems: { open: items.filter((i) => i.status === "OPEN"), closed: items.filter((i) => i.status !== "OPEN") },
          recentSessions: of(server.sessions, String(e.id)),
          sessionCount: of(server.sessions, String(e.id)).length,
          computedAt: STAMP,
        });
      }
      const rows = what === "goals" ? server.goals : what === "indicators" ? server.indicators : what === "action-items" ? server.items : server.sessions;
      if (call.method === "GET") return json(200, { data: of(rows, String(e.id)), count: of(rows, String(e.id)).length });
      try {
        if (typeof body.targetValue === "string") cents(body.targetValue.replace("-", ""));
        if (typeof body.targetAmount === "string") cents(body.targetAmount.replace("-", ""));
      } catch (error) {
        return refusal(400, (error as Error).message);
      }
      const id = `${what}-${(rows.length + 1).toString()}`;
      const toCents = (v: unknown) => (typeof v === "string" ? (BigInt(v.replace(".", "")) ).toString() : null);
      const base = { id, engagementId: e.id, createdById: "u-mentor", createdAt: STAMP, updatedAt: STAMP };
      const row: Row =
        what === "goals"
          ? { ...base, title: body.title, targetValue: toCents(body.targetValue), targetMetric: body.targetMetric ?? null, targetDate: body.targetDate ? `${String(body.targetDate)}T00:00:00.000Z` : null, status: "OPEN" }
          : what === "indicators"
            ? { ...base, name: body.name, sourceKey: body.sourceKey, kind: body.targetAmount !== undefined ? "AMOUNT" : "RATE", targetAmount: toCents(body.targetAmount), targetRate: body.targetRate ?? null, note: body.note ?? null }
            : what === "action-items"
              ? { ...base, title: body.title, responsibleParty: body.responsibleParty, dueDate: body.dueDate ? `${String(body.dueDate)}T00:00:00.000Z` : null, status: "OPEN", completedAt: null, completedById: null }
              : { ...base, sessionDate: `${String(body.sessionDate)}T00:00:00.000Z`, summary: body.summary, observations: body.observations ?? null, commitments: body.commitments ?? null };
      rows.push(row);
      return json(201, row);
    }
    if ((x = /^indicators\/([^/]+)\/actual$/.exec(rest))) {
      const k = server.indicators.find((i) => i.id === x?.[1]);
      const e = k ? active(String(k.engagementId)) : null;
      if (!k || !e) return refusal(404, "No such indicator.");
      read(e, `indicator:${String(k.sourceKey)}`);
      return json(200, { indicatorId: k.id, engagementId: e.id, businessName: e.businessName, name: k.name, sourceKey: k.sourceKey, kind: k.kind, period: PERIOD, targetAmount: k.targetAmount, targetRate: k.targetRate, ...actualOf(k), computedAt: STAMP });
    }
    if ((x = /^(goals|action-items)\/([^/]+)$/.exec(rest)) && call.method === "PATCH") {
      const rows = x[1] === "goals" ? server.goals : server.items;
      const row = rows.find((r) => r.id === x?.[2]);
      if (!row) return refusal(404, "Not found.");
      if (["MET", "MISSED", "DONE", "CANCELLED"].includes(String(row.status))) return refusal(409, `It is ${String(row.status)} and can no longer change.`);
      Object.assign(row, body, body.status === "DONE" ? { completedAt: STAMP, completedById: "u-mentor" } : {});
      return json(200, row);
    }
    if ((x = /^sessions\/([^/]+)$/.exec(rest))) {
      const s = server.sessions.find((r) => r.id === x?.[1]);
      return s ? json(200, s) : refusal(404, "No such session.");
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

export function show(ui: ReactNode) {
  return render(
    <ToastProvider>
      <DataProvider>
        <LocationProvider enabled={false}>
          <main>{ui}</main>
        </LocationProvider>
      </DataProvider>
    </ToastProvider>,
  );
}

/** Reads of a business's figures the server has logged (the owner's access log). */
export const reads = (server: MentorshipServer) => server.log.map((l) => l.resource);
