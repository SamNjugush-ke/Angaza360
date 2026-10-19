// ===========================================================================
// STAFF INVITATIONS (Task T-A5), through the REAL app.
//
// * invite -> accept creates an ACTIVE user with the invited role and business, and
//   the invitation is SINGLE-USE; an expired or revoked one is refused with the same
//   400; the raw token exists only in the delivered message (never in a response, the
//   database or a log line — the accept URL is masked in request logs).
// * THE ROLE-ASSIGNMENT RULES: an owner CANNOT grant a platform role, cannot invite into
//   another business, and roles below owner cannot invite at all — refused (403) with
//   no invitation written. A SUPER_ADMIN grants platform roles (tenantless) and tenant
//   roles anywhere. An owner may add a co-owner.
// * The same rules hold against RAW SQL (`user_invitation_guard`, the tenancy CHECK),
//   each with a control.
// * Every mutation is audited.
// ===========================================================================

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { platformDb } from "../../src/db/platform";
import type { UserRole } from "../../src/generated/platform/enums";
import { errorBody } from "../../src/schemas/common";
import { buildServer, maskSecretPathSegments } from "../../src/server";
import { hashSecretToken } from "../../src/services/identity/secret-token";
import { simulatedOutbox } from "../../src/services/notifications/simulated-provider";
import { dropTenant, provisionFixture, tenantIdOf } from "../setup/tenant";
import { expectDbRefusal } from "../support/db-errors";
import { captureOutput } from "../support/log-capture";
import { withPlatformTx } from "../support/platform-tx";
import { freshIp } from "../security/http-app";
import { bearer, createStaffUser, signIn, type SignedIn, type StaffUser } from "./staff-fixture";

const TENANT_B = "qa-invites-b";
const INVALID = errorBody(400, "BadRequest", "This invitation is invalid or has expired. Ask for a new one.");

let app: FastifyInstance;
let tenantA = "";
let tenantB = "";
let ownerA: SignedIn;
let managerA: SignedIn;
let superAdmin: SignedIn;
const platformUsers: StaffUser[] = [];
const tenantAUsers: string[] = [];

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  tenantA = await tenantIdOf();
  await dropTenant(TENANT_B);
  await provisionFixture(TENANT_B, "QA Invitations B");
  tenantB = await tenantIdOf(TENANT_B);
  const owner = await createStaffUser("MSME_OWNER", tenantA);
  const manager = await createStaffUser("MSME_MANAGER", tenantA);
  const admin = await createStaffUser("SUPER_ADMIN", null);
  tenantAUsers.push(owner.id, manager.id);
  platformUsers.push(admin);
  ownerA = await signIn(app, owner);
  managerA = await signIn(app, manager);
  superAdmin = await signIn(app, admin);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  // Accepted users in tenant A, then the seeded ones; tenant B goes with its users.
  const acceptedInA = await platformDb.userInvitation.findMany({
    where: { tenantId: tenantA, acceptedUserId: { not: null } },
    select: { acceptedUserId: true },
  });
  const acceptedPlatform = await platformDb.userInvitation.findMany({
    where: { tenantId: null, invitedById: superAdmin.user.id, acceptedUserId: { not: null } },
    select: { acceptedUserId: true },
  });
  const ids = [...acceptedInA, ...acceptedPlatform].flatMap((row) => (row.acceptedUserId === null ? [] : [row.acceptedUserId]));
  await platformDb.user.deleteMany({ where: { id: { in: [...ids, ...tenantAUsers, ...platformUsers.map((u) => u.id)] } } });
  await dropTenant(TENANT_B);
  await app.close();
});

function invite(signedIn: SignedIn, body: { email: string; role: UserRole; tenantId?: string; phone?: string }) {
  return app.inject({ method: "POST", url: "/v1/users/invite", remoteAddress: freshIp(), headers: bearer(signedIn.token), payload: body });
}

function accept(token: string, password: string = `Welcome-${randomUUID()}`) {
  return app.inject({
    method: "POST",
    url: `/v1/users/invitations/${token}/accept`,
    remoteAddress: freshIp(),
    payload: { fullName: "QA Invitee", password },
  });
}

function newEmail(): string {
  return `qa-invitee-${randomUUID().slice(0, 8)}@test.invalid`;
}

/** The raw invitation token, read from what the simulator delivered to `email`. */
function deliveredToken(email: string): string {
  const message = [...simulatedOutbox()].reverse().find((candidate) => candidate.to === email);
  const token = message === undefined ? undefined : /\n\n([A-Za-z0-9_-]{20,})\n\n/.exec(message.body)?.[1];
  if (token === undefined) throw new Error(`no invitation delivered to ${email}`);
  return token;
}

describe("invite -> accept", () => {
  it("creates an ACTIVE user with the invited role in the owner's business; the token is single-use and never exposed", async () => {
    const email = newEmail();
    const invited = await invite(ownerA, { email, role: "CASHIER" });
    expect(invited.statusCode).toBe(201);
    const body = invited.json<{ invitation: { id: string; tenantId: string; status: string }; delivery: { email: string } }>();
    expect(body.invitation).toMatchObject({ tenantId: tenantA, status: "PENDING", role: "CASHIER", email });
    expect(body.delivery.email).toBe("SIMULATED");

    const token = deliveredToken(email);
    expect(invited.body).not.toContain(token);
    const stored = await platformDb.userInvitation.findUniqueOrThrow({ where: { id: body.invitation.id } });
    expect(stored.tokenHash).toBe(hashSecretToken(token));

    const password = `Welcome-${randomUUID()}`;
    const { result: accepted, output } = await captureOutput(() => accept(token, password));
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json()).toMatchObject({ email, role: "CASHIER", tenantId: tenantA, isActive: true });
    // The accept URL carries the token: it is masked in the request log. (The masked
    // URL IS in the captured output, so the capture saw the request log at all.)
    expect(output).toContain("/v1/users/invitations/[redacted]/accept");
    expect(output).not.toContain(token);
    expect(output).not.toContain(password);

    const login = await app.inject({ method: "POST", url: "/v1/auth/login", remoteAddress: freshIp(), payload: { email, password } });
    expect(login.statusCode).toBe(200);

    const second = await accept(token);
    expect(second.statusCode).toBe(400);
    expect(second.json()).toStrictEqual(INVALID);

    const invitedAudit = await platformDb.auditLog.findFirstOrThrow({
      where: { action: "USER_INVITED", metadata: { path: ["invitationId"], equals: body.invitation.id } },
    });
    expect(invitedAudit).toMatchObject({ actorUserId: ownerA.user.id, tenantId: tenantA, metadata: { email, role: "CASHIER" } });
    const acceptedAudit = await platformDb.auditLog.findFirstOrThrow({
      where: { action: "INVITATION_ACCEPTED", metadata: { path: ["invitationId"], equals: body.invitation.id } },
    });
    expect(acceptedAudit).toMatchObject({ tenantId: tenantA });
    expect(JSON.stringify([invitedAudit, acceptedAudit])).not.toContain(token);
  });

  it("the request log masks the accept URL's token segment", () => {
    expect(maskSecretPathSegments("/v1/users/invitations/abcDEF123_-xyz/accept")).toBe("/v1/users/invitations/[redacted]/accept");
    expect(maskSecretPathSegments("/v1/webhooks/mpesa/s3cret/qa-fixture")).toBe("/v1/webhooks/mpesa/[redacted]/qa-fixture");
    expect(maskSecretPathSegments("/v1/users")).toBe("/v1/users");
  });

  it("an expired invitation is refused with the same 400 and is recorded EXPIRED", async () => {
    const email = newEmail();
    const invited = await invite(ownerA, { email, role: "WAREHOUSE_STAFF" });
    expect(invited.statusCode).toBe(201);
    const token = deliveredToken(email);
    const ttlHours = Number(process.env["INVITATION_TTL_HOURS"] ?? "72");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + (ttlHours + 1) * 3_600_000);
    const late = await accept(token);
    expect(late.statusCode).toBe(400);
    expect(late.json()).toStrictEqual(INVALID);
    vi.useRealTimers();
    const row = await platformDb.userInvitation.findUniqueOrThrow({ where: { tokenHash: hashSecretToken(token) } });
    expect(row.status).toBe("EXPIRED");
    expect(await platformDb.user.count({ where: { email } })).toBe(0);
  });

  it("a revoked invitation cannot be accepted; revoking is audited; another business cannot revoke it", async () => {
    const email = newEmail();
    const invited = await invite(ownerA, { email, role: "HR_OFFICER" });
    const { invitation } = invited.json<{ invitation: { id: string } }>();
    const token = deliveredToken(email);

    const ownerB = await signIn(app, await createStaffUser("MSME_OWNER", tenantB));
    const foreign = await app.inject({ method: "POST", url: `/v1/users/invitations/${invitation.id}/revoke`, headers: bearer(ownerB.token) });
    expect(foreign.statusCode).toBe(404);

    const revoked = await app.inject({ method: "POST", url: `/v1/users/invitations/${invitation.id}/revoke`, headers: bearer(ownerA.token) });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ status: "REVOKED" });
    expect((await accept(token)).json()).toStrictEqual(INVALID);
    const audit = await platformDb.auditLog.findFirstOrThrow({
      where: { action: "INVITATION_REVOKED", metadata: { path: ["invitationId"], equals: invitation.id } },
    });
    expect(audit).toMatchObject({ actorUserId: ownerA.user.id, tenantId: tenantA });
  });

  it("refuses an email that already has a user, and a second open invitation for the same email", async () => {
    const existing = await invite(ownerA, { email: managerA.user.email, role: "CASHIER" });
    expect(existing.statusCode).toBe(409);
    const email = newEmail();
    expect((await invite(ownerA, { email, role: "CASHIER" })).statusCode).toBe(201);
    expect((await invite(ownerA, { email, role: "ACCOUNTANT" })).statusCode).toBe(409);
  });

  it("SMS is first-class: a phone on the invitation gets the same token by SMS", async () => {
    const email = newEmail();
    const phone = `+2547${Math.floor(10_000_000 + Math.random() * 89_999_999).toString()}`;
    const invited = await invite(ownerA, { email, role: "CASHIER", phone });
    expect(invited.json()).toMatchObject({ delivery: { email: "SIMULATED", sms: "SIMULATED" } });
    const sms = [...simulatedOutbox()].reverse().find((message) => message.to === phone);
    expect(sms?.body).toContain(deliveredToken(email));
  });
});

describe("the role-assignment rules (no privilege escalation)", () => {
  it.each<UserRole>(["SUPER_ADMIN", "PROGRAM_OFFICER", "MENTOR", "COACH"])(
    "an owner CANNOT grant the platform role %s — 403, nothing written",
    async (role) => {
      const email = newEmail();
      const response = await invite(ownerA, { email, role });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ statusCode: 403, error: "Forbidden" });
      expect(await platformDb.userInvitation.count({ where: { email } })).toBe(0);
    },
  );

  it("an owner cannot invite into ANOTHER business", async () => {
    const email = newEmail();
    const response = await invite(ownerA, { email, role: "CASHIER", tenantId: tenantB });
    expect(response.statusCode).toBe(403);
    expect(await platformDb.userInvitation.count({ where: { email } })).toBe(0);
  });

  it("roles below owner cannot invite at all", async () => {
    const response = await invite(managerA, { email: newEmail(), role: "CASHIER" });
    expect(response.statusCode).toBe(403);
  });

  it("an owner MAY add a co-owner (equal is not above)", async () => {
    const response = await invite(ownerA, { email: newEmail(), role: "MSME_OWNER" });
    expect(response.statusCode).toBe(201);
  });

  it("a SUPER_ADMIN grants a platform role tenantless, and a tenant role only with a tenant", async () => {
    const email = newEmail();
    const mentor = await invite(superAdmin, { email, role: "MENTOR" });
    expect(mentor.statusCode).toBe(201);
    expect(mentor.json()).toMatchObject({ invitation: { tenantId: null, role: "MENTOR" } });
    const created = await accept(deliveredToken(email));
    expect(created.json()).toMatchObject({ role: "MENTOR", tenantId: null });

    expect((await invite(superAdmin, { email: newEmail(), role: "CASHIER" })).statusCode).toBe(400);
    expect((await invite(superAdmin, { email: newEmail(), role: "MENTOR", tenantId: tenantB })).statusCode).toBe(400);
    const intoB = await invite(superAdmin, { email: newEmail(), role: "CASHIER", tenantId: tenantB });
    expect(intoB.statusCode).toBe(201);
    expect(intoB.json()).toMatchObject({ invitation: { tenantId: tenantB } });
  });
});

describe("the invitation's database guarantees (raw SQL)", () => {
  function insertInvitation(client: PoolClient, values: { invitedById: string; role: UserRole; tenantId: string | null }) {
    return client.query(
      `INSERT INTO public.user_invitations ("id", "email", "role", "tenantId", "invitedById", "tokenHash", "expiresAt")
       VALUES ($1, $2, $3::"UserRole", $4, $5, $6, now() + interval '1 day')`,
      [randomUUID(), newEmail(), values.role, values.tenantId, values.invitedById, hashSecretToken(randomUUID())],
    );
  }

  it("control: an owner inviting a tenant role into their own business is accepted", async () => {
    await withPlatformTx(async (client) => {
      await insertInvitation(client, { invitedById: ownerA.user.id, role: "CASHIER", tenantId: tenantA });
    });
  });

  it("an owner granting a platform role is refused by the guard", async () => {
    await withPlatformTx(async (client) => {
      await expectDbRefusal(insertInvitation(client, { invitedById: ownerA.user.id, role: "SUPER_ADMIN", tenantId: null }), {
        fn: "user_invitation_guard",
        message: /may not grant the role SUPER_ADMIN/,
      });
    });
  });

  it("an owner granting a role in another business is refused by the guard", async () => {
    await withPlatformTx(async (client) => {
      await expectDbRefusal(insertInvitation(client, { invitedById: ownerA.user.id, role: "CASHIER", tenantId: tenantB }), {
        fn: "user_invitation_guard",
      });
    });
  });

  it("a manager inviting anyone is refused by the guard", async () => {
    await withPlatformTx(async (client) => {
      await expectDbRefusal(insertInvitation(client, { invitedById: managerA.user.id, role: "CASHIER", tenantId: tenantA }), {
        fn: "user_invitation_guard",
      });
    });
  });

  it("a platform role WITH a tenant is refused by the tenancy CHECK", async () => {
    await withPlatformTx(async (client) => {
      await expectDbRefusal(insertInvitation(client, { invitedById: superAdmin.user.id, role: "MENTOR", tenantId: tenantB }), {
        constraint: "user_invitation_role_matches_tenancy",
        code: "23514",
      });
    });
  });

  it("a decided invitation is terminal", async () => {
    await withPlatformTx(async (client) => {
      const id = randomUUID();
      await client.query(
        `INSERT INTO public.user_invitations ("id", "email", "role", "tenantId", "invitedById", "tokenHash", "expiresAt")
         VALUES ($1, $2, 'CASHIER', $3, $4, $5, now() + interval '1 day')`,
        [id, newEmail(), tenantA, ownerA.user.id, hashSecretToken(randomUUID())],
      );
      await client.query(`UPDATE public.user_invitations SET "status" = 'REVOKED' WHERE "id" = $1`, [id]);
      await expectDbRefusal(client.query(`UPDATE public.user_invitations SET "status" = 'PENDING' WHERE "id" = $1`, [id]), {
        fn: "user_invitation_guard",
        message: /terminal/,
      });
    });
  });
});
