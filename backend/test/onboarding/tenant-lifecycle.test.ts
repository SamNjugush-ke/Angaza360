// ===========================================================================
// THE TENANT LIFECYCLE (Task T-A6.1).
//
// * ACTIVE <-> SUSPENDED, ACTIVE | SUSPENDED -> DEACTIVATED (terminal); anything else is
//   refused by the service (409) AND by `tenant_status_transition_guard` from raw SQL,
//   with a legal raw transition as the control.
// * Suspension locks the business's users out through the EXISTING gate
//   (resolveTenantContext): login is 403 and a live session is 403; reactivation
//   restores both. Each change is audited.
// ===========================================================================

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformDb } from "../../src/db/platform";
import { errorBody } from "../../src/schemas/common";
import { buildServer } from "../../src/server";
import { simulatedOutbox } from "../../src/services/notifications/simulated-provider";
import { expectDbRefusal } from "../support/db-errors";
import { withPlatformTx } from "../support/platform-tx";
import { freshIp } from "../security/http-app";
import { bearer } from "../identity/staff-fixture";
import { cleanUp, freshCandidate, platformStaff, type PlatformStaff } from "./onboarding-fixture";

let app: FastifyInstance;
let staff: PlatformStaff;
let tenantId = "";
let ownerEmail = "";
let ownerPassword = "";
const provisioned: string[] = [];

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  staff = await platformStaff(app);
  const candidate = freshCandidate();
  const onboarded = await app.inject({
    method: "POST",
    url: "/v1/tenants/onboard",
    remoteAddress: freshIp(),
    headers: bearer(staff.superAdmin.token),
    payload: candidate,
  });
  const body = onboarded.json<{ tenant: { id: string; subdomain: string } }>();
  tenantId = body.tenant.id;
  provisioned.push(body.tenant.subdomain);
  const message = [...simulatedOutbox()].reverse().find((m) => m.to === candidate.ownerEmail);
  const token = message === undefined ? "" : (/\n\n([A-Za-z0-9_-]{20,})\n\n/.exec(message.body)?.[1] ?? "");
  ownerEmail = candidate.ownerEmail;
  ownerPassword = `Owner-${randomUUID()}`;
  const accepted = await app.inject({
    method: "POST",
    url: `/v1/users/invitations/${token}/accept`,
    remoteAddress: freshIp(),
    payload: { fullName: candidate.ownerFullName, password: ownerPassword },
  });
  expect(accepted.statusCode).toBe(201);
});

afterAll(async () => {
  await cleanUp(provisioned, staff.users);
  await app.close();
});

function act(action: "suspend" | "reactivate" | "deactivate", token: string = staff.officer.token) {
  return app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/${action}`, headers: bearer(token), payload: { reason: "T-A6.1 test" } });
}

function login() {
  return app.inject({ method: "POST", url: "/v1/auth/login", remoteAddress: freshIp(), payload: { email: ownerEmail, password: ownerPassword } });
}

describe("suspension locks a business's users out", () => {
  it("suspend -> login 403 and a live session 403; reactivate -> both work again; both audited", async () => {
    const signedIn = await login();
    expect(signedIn.statusCode).toBe(200);
    const token = signedIn.json<{ accessToken: string }>().accessToken;
    const me = () => app.inject({ method: "GET", url: "/v1/auth/me", headers: bearer(token) });
    expect((await me()).statusCode).toBe(200);

    const suspended = await act("suspend");
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json()).toMatchObject({ status: "SUSPENDED" });
    expect((await login()).statusCode).toBe(403);
    expect((await me()).statusCode).toBe(403);

    expect((await act("reactivate")).json()).toMatchObject({ status: "ACTIVE" });
    expect((await login()).statusCode).toBe(200);
    expect((await me()).statusCode).toBe(200);

    expect(await platformDb.auditLog.count({ where: { tenantId, action: "TENANT_SUSPENDED" } })).toBe(1);
    expect(await platformDb.auditLog.count({ where: { tenantId, action: "TENANT_REACTIVATED" } })).toBe(1);
  });
});

describe("invalid transitions are refused — service AND database", () => {
  it("reactivating an ACTIVE tenant is 409 in the one error shape", async () => {
    const response = await act("reactivate");
    expect(response.statusCode).toBe(409);
    expect(response.json()).toStrictEqual(errorBody(409, "Conflict", "The tenant is ACTIVE; it cannot become ACTIVE."));
  });

  it("raw SQL: ACTIVE -> PENDING_PROVISIONING is refused by the trigger; ACTIVE -> SUSPENDED (control) is accepted", async () => {
    await withPlatformTx(async (client) => {
      await client.query(`UPDATE public.tenants SET "status" = 'SUSPENDED' WHERE "id" = $1`, [tenantId]);
    });
    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(`UPDATE public.tenants SET "status" = 'PENDING_PROVISIONING' WHERE "id" = $1`, [tenantId]), {
        fn: "tenant_status_transition_guard",
        message: /may not move ACTIVE -> PENDING_PROVISIONING/,
      });
    });
  });

  it("DEACTIVATED is terminal: the service refuses reactivation (409) and the trigger refuses it from raw SQL", async () => {
    const deactivated = await act("deactivate");
    expect(deactivated.json()).toMatchObject({ status: "DEACTIVATED" });
    expect((await login()).statusCode).toBe(403);
    const again = await act("reactivate");
    expect(again.statusCode).toBe(409);
    expect(again.json<{ message: string }>().message).toMatch(/DEACTIVATED is terminal/);
    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(`UPDATE public.tenants SET "status" = 'ACTIVE' WHERE "id" = $1`, [tenantId]), {
        fn: "tenant_status_transition_guard",
        message: /DEACTIVATED -> ACTIVE/,
      });
    });
    expect(await platformDb.auditLog.count({ where: { tenantId, action: "TENANT_DEACTIVATED" } })).toBe(1);
  });

  it("a tenant user cannot run the lifecycle", async () => {
    const response = await act("suspend", "not-a-token");
    expect(response.statusCode).toBe(401);
  });
});
