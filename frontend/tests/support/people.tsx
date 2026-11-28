import { render } from "@testing-library/react";
import { vi } from "vitest";
import { People } from "@/components/people/people";
import { DataProvider } from "@/components/providers/data-provider";
import { LocationProvider } from "@/components/shell/location";
import { ToastProvider } from "@/components/toast/toast";
import { json, refusal, type Call } from "./money";

// A fake /v1/users server for the People & access tests: the business's staff, invitations
// (whose code is NEVER in a response, as in the API), role changes, deactivation and the identity
// audit trail each change appends to. It refuses as the API does: an existing email, an open
// invitation, a role the user already has, the last active owner, a revoke of a non-PENDING one.

export interface Person {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  role: string;
  tenantId: string;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface PeopleServer {
  calls: Call[];
  routes: Array<(call: Call) => Response | null>;
  staff: Person[];
  invitations: Array<{ id: string; email: string; role: string; status: string; tokenHash: string }>;
  audit: Array<Record<string, unknown>>;
}

const person = (id: string, fullName: string, role: string, over: Partial<Person> = {}): Person => ({
  id,
  email: `${id}@nakuru.test`,
  fullName,
  phone: null,
  role,
  tenantId: "t-nakuru",
  isActive: true,
  lastLoginAt: "2026-11-09T07:00:00.000Z",
  createdAt: "2026-10-01T07:00:00.000Z",
  ...over,
});

export const SELF = "u-owner";

export function installPeopleServer(): PeopleServer {
  const staff = [
    person(SELF, "Wanjiru Owner", "MSME_OWNER"),
    person("u-mgr", "Otieno Manager", "MSME_MANAGER"),
    person("u-cash", "Akinyi Cashier", "CASHIER"),
    person("u-view", "Mwangi Auditor", "VIEWER_AUDITOR", { isActive: false, lastLoginAt: null }),
  ];
  const server: PeopleServer = { calls: [], routes: [], staff, invitations: [], audit: [] };
  const record = (action: string, targetUserId: string | null, metadata: Record<string, unknown> = {}) =>
    server.audit.unshift({ id: `a-${(server.audit.length + 1).toString()}`, action, actorUserId: SELF, targetUserId, tenantId: "t-nakuru", ipAddress: "127.0.0.1", metadata, occurredAt: "2026-11-10T08:00:00.000Z" });
  const activeOwners = () => staff.filter((p) => p.role === "MSME_OWNER" && p.isActive).length;
  const invitationView = (i: PeopleServer["invitations"][number]) => ({ id: i.id, email: i.email, role: i.role, tenantId: "t-nakuru", status: i.status, expiresAt: "2026-11-13T08:00:00.000Z", createdAt: "2026-11-10T08:00:00.000Z" });

  const answer = (call: Call): Response | null => {
    const path = call.url.pathname;
    const body = (call.body ?? {}) as Record<string, string>;
    if (path === "/api/v1/locations") return json(200, { data: [] });
    if (path === "/api/v1/users" && call.method === "GET") return json(200, { data: staff });
    if (path === "/api/v1/users/audit" && call.method === "GET") return json(200, { data: server.audit.slice(0, Number(call.url.searchParams.get("limit") ?? "50")) });
    if (path === "/api/v1/users/invitations" && call.method === "GET") {
      // The business's open invitations, newest first (T-B-INVITE-LIST); never a code.
      return json(200, { data: [...server.invitations].reverse().filter((i) => i.status === "PENDING").map(invitationView) });
    }
    if (path === "/api/v1/users/invite" && call.method === "POST") {
      const email = (body.email ?? "").toLowerCase();
      if (staff.some((p) => p.email === email)) return refusal(409, "A user with that email already exists.");
      if (server.invitations.some((i) => i.email === email && i.status === "PENDING")) return refusal(409, "That email already has an open invitation. Revoke it first to send a new one.");
      const invitation = { id: `inv-${(server.invitations.length + 1).toString()}`, email, role: body.role ?? "", status: "PENDING", tokenHash: "f".repeat(64) };
      server.invitations.push(invitation);
      record("USER_INVITED", null, { invitationId: invitation.id, email, role: invitation.role });
      return json(201, { invitation: invitationView(invitation), delivery: { email: "SIMULATED", sms: body.phone ? "SIMULATED" : null } });
    }
    const revoke = /^\/api\/v1\/users\/invitations\/([^/]+)\/revoke$/.exec(path);
    if (revoke && call.method === "POST") {
      const i = server.invitations.find((x) => x.id === revoke[1]);
      if (!i) return refusal(404, "No such invitation in your business.");
      if (i.status !== "PENDING") return refusal(409, `The invitation is ${i.status}; only a PENDING invitation can be revoked.`);
      i.status = "REVOKED";
      record("INVITATION_REVOKED", null, { invitationId: i.id, email: i.email });
      return json(200, invitationView(i));
    }
    const act = /^\/api\/v1\/users\/([^/]+)\/(role|deactivate|reactivate)$/.exec(path);
    if (act) {
      const target = staff.find((p) => p.id === act[1]);
      if (!target) return refusal(404, "No such user in your business.");
      if (act[2] === "role" && call.method === "PATCH") {
        if (target.role === body.role) return refusal(409, `The user already has the role ${body.role ?? ""}.`);
        if (target.role === "MSME_OWNER" && body.role !== "MSME_OWNER" && activeOwners() === 1) return refusal(409, "A business must keep at least one active owner.");
        const from = target.role;
        target.role = body.role ?? target.role;
        record("ROLE_CHANGED", target.id, { fromRole: from, toRole: target.role });
        return json(200, target);
      }
      if (act[2] === "deactivate" && call.method === "POST") {
        if (!target.isActive) return refusal(409, "The user is already deactivated.");
        if (target.role === "MSME_OWNER" && activeOwners() === 1) return refusal(409, "A business must keep at least one active owner.");
        target.isActive = false;
        record("USER_DEACTIVATED", target.id);
        return json(200, target);
      }
      if (act[2] === "reactivate" && call.method === "POST") {
        if (target.isActive) return refusal(409, "The user is already active.");
        target.isActive = true;
        record("USER_REACTIVATED", target.id);
        return json(200, target);
      }
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

export function showPeople(selfId = SELF) {
  return render(
    <ToastProvider>
      <DataProvider>
        <LocationProvider enabled={false}>
          <main>
            <People selfId={selfId} />
          </main>
        </LocationProvider>
      </DataProvider>
    </ToastProvider>,
  );
}
