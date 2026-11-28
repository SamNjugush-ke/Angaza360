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
import { env } from "../../src/config/env";
import { platformDb } from "../../src/db/platform";
import type { UserRole } from "../../src/generated/platform/enums";
import { errorBody } from "../../src/schemas/common";
import { buildServer, maskSecretPathSegments } from "../../src/server";
import { hashSecretToken } from "../../src/services/identity/secret-token";
import { listPendingInvitations } from "../../src/services/identity/user-management";
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
  const token = message === undefined ? undefined : /\/invite\/([A-Za-z0-9_-]{20,})/.exec(message.body)?.[1];
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

  it("T-B-INVITE-LINK: the email AND the SMS carry <APP_BASE_URL>/invite/<code>, and no API response carries the code", async () => {
    const email = newEmail();
    const phone = `+2547${Math.floor(10_000_000 + Math.random() * 89_999_999).toString()}`;
    const invited = await invite(ownerA, { email, role: "WAREHOUSE_STAFF", phone });
    const token = deliveredToken(email);
    const link = `${env.appBaseUrl}/invite/${token}`;
    const mail = [...simulatedOutbox()].reverse().find((message) => message.to === email);
    const sms = [...simulatedOutbox()].reverse().find((message) => message.to === phone);
    expect(mail?.body).toContain(`\n\n${link}\n\n`);
    expect(mail?.body).toContain(`enter this code: ${token}`);
    expect(sms?.body).toContain(link);
    expect((sms?.body ?? "").length).toBeLessThanOrEqual(160);
    expect(invited.body).not.toContain(token);
    // The link's code is the real one: the invite page's preview accepts it.
    const previewed = await app.inject({ method: "GET", url: `/v1/users/invitations/${token}`, remoteAddress: freshIp() });
    expect(previewed.statusCode).toBe(200);
  });
});

function preview(token: string) {
  return app.inject({ method: "GET", url: `/v1/users/invitations/${token}`, remoteAddress: freshIp() });
}

describe("the invitation preview (Task T-B-INVITE-PREVIEW)", () => {
  it("shows what a PENDING invitation offers, writes nothing, and masks the token in the request log", async () => {
    const email = newEmail();
    const invited = await invite(ownerA, { email, role: "ACCOUNTANT" });
    expect(invited.statusCode).toBe(201);
    const id = invited.json<{ invitation: { id: string } }>().invitation.id;
    const token = deliveredToken(email);
    const before = await platformDb.userInvitation.findUniqueOrThrow({ where: { id } });

    const { result: shown, output } = await captureOutput(() => preview(token));
    expect(shown.statusCode).toBe(200);
    const tenant = await platformDb.tenant.findUniqueOrThrow({ where: { id: tenantA }, select: { name: true } });
    expect(shown.json()).toStrictEqual({ email, role: "ACCOUNTANT", businessName: tenant.name, expiresAt: before.expiresAt.toISOString() });
    expect(shown.body).not.toContain(token);
    expect(output).toContain("/v1/users/invitations/[redacted]");
    expect(output).not.toContain(token);
    expect(await platformDb.userInvitation.findUniqueOrThrow({ where: { id } })).toStrictEqual(before);

    // Previewing does not consume it: it can still be accepted, and then the preview refuses.
    expect((await accept(token)).statusCode).toBe(201);
    const after = await preview(token);
    expect(after.statusCode).toBe(400);
    expect(after.json()).toStrictEqual(INVALID);
  });

  it("gives an unknown, revoked or expired invitation the accept call's one 400, and records nothing", async () => {
    const unknown = await preview("no-such-invitation-token-0123456789");
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toStrictEqual(INVALID);

    const revokedEmail = newEmail();
    const revoked = await invite(ownerA, { email: revokedEmail, role: "CASHIER" });
    const revokedId = revoked.json<{ invitation: { id: string } }>().invitation.id;
    const revokedToken = deliveredToken(revokedEmail);
    const revoke = await app.inject({ method: "POST", url: `/v1/users/invitations/${revokedId}/revoke`, remoteAddress: freshIp(), headers: bearer(ownerA.token) });
    expect(revoke.statusCode).toBe(200);
    expect((await preview(revokedToken)).json()).toStrictEqual(INVALID);

    const expiredEmail = newEmail();
    const expiring = await invite(ownerA, { email: expiredEmail, role: "CASHIER" });
    const expiringId = expiring.json<{ invitation: { id: string } }>().invitation.id;
    const expiredToken = deliveredToken(expiredEmail);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + (Number(process.env["INVITATION_TTL_HOURS"] ?? "72") + 1) * 3_600_000);
    const expired = await preview(expiredToken);
    vi.useRealTimers();
    expect(expired.statusCode).toBe(400);
    expect(expired.json()).toStrictEqual(INVALID);
    // A preview writes nothing: the expired invitation is still PENDING until an accept attempt.
    expect((await platformDb.userInvitation.findUniqueOrThrow({ where: { id: expiringId } })).status).toBe("PENDING");
  });

  it("names no business for a platform role", async () => {
    const email = newEmail();
    expect((await invite(superAdmin, { email, role: "MENTOR" })).statusCode).toBe(201);
    expect((await preview(deliveredToken(email))).json()).toMatchObject({ email, role: "MENTOR", businessName: null });
  });

  it("the request log masks a preview URL too, and leaves the revoke URL (an id, not a secret) alone", () => {
    expect(maskSecretPathSegments("/v1/users/invitations/abcDEF123_-xyz")).toBe("/v1/users/invitations/[redacted]");
    expect(maskSecretPathSegments("/v1/users/invitations/abcDEF123_-xyz?x=1")).toBe("/v1/users/invitations/[redacted]?x=1");
    expect(maskSecretPathSegments("/v1/users/invitations/0b1c/revoke")).toBe("/v1/users/invitations/0b1c/revoke");
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

describe("the open-invitations list (Task T-B-INVITE-LIST)", () => {
  const list = (signedIn: SignedIn, query = "") => app.inject({ method: "GET", url: `/v1/users/invitations${query}`, headers: bearer(signedIn.token) });

  it("lists the owner's own business's PENDING invitations — not another business's, not revoked ones — and never a code", async () => {
    const mine = newEmail();
    const revoked = newEmail();
    const elsewhere = newEmail();
    await invite(ownerA, { email: mine, role: "CASHIER" });
    const toRevoke = (await invite(ownerA, { email: revoked, role: "CASHIER" })).json<{ invitation: { id: string } }>();
    await app.inject({ method: "POST", url: `/v1/users/invitations/${toRevoke.invitation.id}/revoke`, headers: bearer(ownerA.token) });
    await invite(superAdmin, { email: elsewhere, role: "CASHIER", tenantId: tenantB });

    const response = await list(ownerA);
    expect(response.statusCode).toBe(200);
    const emails = response.json<{ data: Array<{ email: string; status: string; tenantId: string }> }>().data.map((i) => i.email);
    expect(emails).toContain(mine);
    expect(emails).not.toContain(revoked);
    expect(emails).not.toContain(elsewhere);
    expect(response.body).not.toContain(deliveredToken(mine));

    // The SUPER_ADMIN sees every business's, or one business's.
    const b = (await list(superAdmin, `?tenantId=${tenantB}`)).json<{ data: Array<{ email: string }> }>().data.map((i) => i.email);
    expect(b).toContain(elsewhere);
    expect(b).not.toContain(mine);
  });

  it("leaves out an expired invitation, and refuses a manager and an owner asking for another business", async () => {
    const email = newEmail();
    await invite(ownerA, { email, role: "CASHIER" });
    expect((await list(ownerA)).json<{ data: Array<{ email: string }> }>().data.map((i) => i.email)).toContain(email);
    // Past its expiry (the row's expiry is frozen by its guard, so the clock moves instead).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + (env.invitationTtlHours + 1) * 3_600_000);
    // (A session would have expired too, so ask the service directly.)
    const open = await listPendingInvitations({ userId: ownerA.user.id, role: "MSME_OWNER", tenantId: tenantA, ipAddress: null }, { tenantId: null });
    expect(open.map((i) => i.email)).not.toContain(email);
    vi.useRealTimers();
    expect((await list(managerA)).statusCode).toBe(403);
    expect((await list(ownerA, `?tenantId=${tenantB}`)).statusCode).toBe(403);
  });
});
