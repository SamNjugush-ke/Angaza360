// ===========================================================================
// NATIVE TOTP MFA + FORCED RESET ON FIRST LOGIN (M4.5 Wave 1), through the REAL app.
//
// * An administrator (SUPER_ADMIN / PROGRAM_OFFICER) can NEVER hold a session without a
//   proven second factor: their first login is an enrolment, every later one a code, and
//   the database refuses an admin session born without `mfaVerifiedAt`.
// * Bypass attempts fail: a missing factor, a replayed TOTP, a reused backup code, brute
//   force (the challenge burns), the wrong stage, a promoted password-only session.
// * The secret is stored encrypted and never returned after enrolment; backup codes are
//   stored only as hashes; none of them reaches a log line.
// * A forced reset is un-skippable: no session until a NEW password is set, and an
//   account flagged while signed in is locked out at once.
// * Step-up and admin-assisted recovery: an MFA or password reset of another user needs
//   a fresh code, exposes no secret, signs the target out and is audited.
// * The guards are attacked from raw SQL, each with a legitimate write as the control.
// ===========================================================================

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformDb } from "../../src/db/platform";
import { buildServer } from "../../src/server";
import { hashSecretToken } from "../../src/services/identity/secret-token";
import { totpCodeAt } from "../../src/services/identity/mfa";
import { simulatedOutbox } from "../../src/services/notifications/simulated-provider";
import { expectDbRefusal } from "../support/db-errors";
import { captureOutput } from "../support/log-capture";
import { enrollmentOf, freshCode, rememberEnrollment, stepUp } from "../support/mfa";
import { withPlatformTx } from "../support/platform-tx";
import { accessTokenFor, freshIp } from "../security/http-app";
import { bearer, createStaffUser, type StaffUser } from "./staff-fixture";
import { tenantIdOf, FIXTURE_SUBDOMAIN } from "../setup/tenant";

let app: FastifyInstance;
const users: StaffUser[] = [];
let fixtureTenantId: string;

interface Body {
  status?: string;
  error?: string;
  accessToken?: string;
  refreshToken?: string;
  challengeToken?: string;
  secret?: string;
  otpauthUri?: string;
  backupCodes?: string[];
  result?: Body;
  message?: string;
}

async function post(url: string, payload: Record<string, string>, headers: Record<string, string> = {}): Promise<{ status: number; body: Body; raw: string }> {
  const response = await app.inject({ method: "POST", url, remoteAddress: freshIp(), payload, headers });
  return { status: response.statusCode, body: response.json<Body>(), raw: response.body };
}

async function login(user: StaffUser): Promise<{ status: number; body: Body }> {
  return post("/v1/auth/login", { email: user.email, password: user.password });
}

async function staff(role: StaffUser["role"], tenantId: string | null): Promise<StaffUser> {
  const user = await createStaffUser(role, tenantId);
  users.push(user);
  return user;
}

async function sessionCount(userId: string): Promise<number> {
  return platformDb.session.count({ where: { userId } });
}

/** Enrols an administrator through the login challenge and returns their token. */
async function enrolledAdmin(role: "SUPER_ADMIN" | "PROGRAM_OFFICER" = "SUPER_ADMIN"): Promise<{ user: StaffUser; token: string }> {
  const user = await staff(role, null);
  return { user, token: await accessTokenFor(app, user) };
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  fixtureTenantId = await tenantIdOf(FIXTURE_SUBDOMAIN);
});

afterAll(async () => {
  await platformDb.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
  await app.close();
});

describe("an administrator can never sign in without a second factor", () => {
  it("a first login is an enrolment: no session until the authenticator is confirmed", async () => {
    const admin = await staff("SUPER_ADMIN", null);
    const first = await login(admin);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("MFA_ENROLLMENT_REQUIRED");
    expect(first.body.accessToken).toBeUndefined();
    expect(await sessionCount(admin.id)).toBe(0);

    const challengeToken = first.body.challengeToken ?? "";
    const start = await post("/v1/auth/login/mfa-enrollment/start", { challengeToken });
    expect(start.status).toBe(200);
    const secret = start.body.secret ?? "";
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(start.body.otpauthUri).toContain("otpauth://totp/");

    // Stored ENCRYPTED: the secret appears in no column of the user row.
    const row = await platformDb.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(row.mfaEnabled).toBe(false);
    expect(row.mfaSecretCiphertext).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain(secret);

    const wrong = await post("/v1/auth/login/mfa-enrollment/confirm", { challengeToken, code: "000000" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe("InvalidCode");
    expect(await sessionCount(admin.id)).toBe(0);

    rememberEnrollment(admin.email, secret, []);
    const confirm = await post("/v1/auth/login/mfa-enrollment/confirm", { challengeToken, code: freshCode(admin.email) });
    expect(confirm.status).toBe(200);
    expect(confirm.body.backupCodes).toHaveLength(10);
    expect(confirm.body.result?.status).toBe("AUTHENTICATED");
    enrollmentOf(admin.email)?.backupCodes.push(...(confirm.body.backupCodes ?? []));

    const session = await platformDb.session.findFirstOrThrow({ where: { userId: admin.id } });
    expect(session.mfaVerifiedAt).not.toBeNull();
    // Backup codes are stored only as hashes.
    const stored = await platformDb.mfaBackupCode.findMany({ where: { userId: admin.id } });
    expect(stored).toHaveLength(10);
    const hashes = new Set(stored.map((code) => code.codeHash));
    for (const code of confirm.body.backupCodes ?? []) {
      expect(hashes.has(code)).toBe(false);
    }
    // The challenge is spent: it cannot mint a second session.
    const again = await post("/v1/auth/login/mfa-enrollment/confirm", { challengeToken, code: freshCode(admin.email) });
    expect(again.status).toBe(401);
    expect(await sessionCount(admin.id)).toBe(1);
  });

  it("a later login demands a code, and a PROGRAM_OFFICER is held to the same rule", async () => {
    for (const role of ["SUPER_ADMIN", "PROGRAM_OFFICER"] as const) {
      const { user } = await enrolledAdmin(role);
      const second = await login(user);
      expect(second.body.status).toBe("MFA_REQUIRED");
      expect(second.body.accessToken).toBeUndefined();
      const ok = await post("/v1/auth/login/mfa", { challengeToken: second.body.challengeToken ?? "", code: freshCode(user.email) });
      expect(ok.status).toBe(200);
      expect(ok.body.status).toBe("AUTHENTICATED");
    }
  });

  it("refuses a missing factor, the wrong stage, a forged or spent challenge — one answer", async () => {
    const { user } = await enrolledAdmin();
    const challenge = await login(user);
    const challengeToken = challenge.body.challengeToken ?? "";
    // Skipping the factor by jumping to another stage.
    expect((await post("/v1/auth/login/password", { challengeToken, newPassword: "an-entirely-new-password" })).status).toBe(401);
    expect((await post("/v1/auth/login/mfa-enrollment/start", { challengeToken })).status).toBe(401);
    // A forged challenge.
    const forged = await post("/v1/auth/login/mfa", { challengeToken: "not-a-real-challenge-token", code: "123456" });
    expect(forged.status).toBe(401);
    expect(forged.body.error).toBe("ChallengeInvalid");
    // An empty code fails the schema; no session either way.
    expect((await post("/v1/auth/login/mfa", { challengeToken, code: "" })).status).toBe(400);
    expect(await sessionCount(user.id)).toBe(1);
  });

  it("refuses a REPLAYED TOTP code, even inside its own 30 seconds", async () => {
    const { user } = await enrolledAdmin();
    const code = freshCode(user.email);
    const first = await login(user);
    expect((await post("/v1/auth/login/mfa", { challengeToken: first.body.challengeToken ?? "", code })).body.status).toBe("AUTHENTICATED");
    const second = await login(user);
    const replay = await post("/v1/auth/login/mfa", { challengeToken: second.body.challengeToken ?? "", code });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe("InvalidCode");
  });

  it("burns a backup code on use: the same code never works twice", async () => {
    const { user } = await enrolledAdmin();
    const backup = enrollmentOf(user.email)?.backupCodes.shift() ?? "";
    expect(backup).not.toBe("");
    const first = await login(user);
    const used = await post("/v1/auth/login/mfa", { challengeToken: first.body.challengeToken ?? "", code: backup.toLowerCase() });
    expect(used.body.status).toBe("AUTHENTICATED");
    const second = await login(user);
    const reused = await post("/v1/auth/login/mfa", { challengeToken: second.body.challengeToken ?? "", code: backup });
    expect(reused.status).toBe(401);
    const audit = await platformDb.auditLog.findFirst({ where: { action: "MFA_BACKUP_CODE_USED", targetUserId: user.id } });
    expect(audit?.metadata).toEqual({ remaining: 9 });
  });

  it("brute force burns the challenge: after the attempt limit even the right code is refused", async () => {
    const { user } = await enrolledAdmin();
    const challenge = await login(user);
    const challengeToken = challenge.body.challengeToken ?? "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await post("/v1/auth/login/mfa", { challengeToken, code: (100000 + attempt).toString() });
      expect(wrong.status).toBe(401);
    }
    const right = await post("/v1/auth/login/mfa", { challengeToken, code: freshCode(user.email) });
    expect(right.status).toBe(401);
    expect(right.body.error).toBe("ChallengeInvalid");
    const row = await platformDb.loginChallenge.findUniqueOrThrow({ where: { tokenHash: hashSecretToken(challengeToken) } });
    expect(row.failedAttempts).toBe(5);
    expect(row.consumedAt).not.toBeNull();
    expect(await platformDb.auditLog.count({ where: { action: "MFA_CHALLENGE_FAILED", targetUserId: user.id } })).toBe(5);
  });

  it("the stage routes are throttled per IP on the AUTH tier", async () => {
    const ip = freshIp();
    const codes: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/login/mfa",
        remoteAddress: ip,
        payload: { challengeToken: "nothing-here-at-all", code: "123456" },
      });
      codes.push(response.statusCode);
    }
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes[5]).toBe(429);
  });

  it("a password-only session promoted to an admin role is refused on every route (MfaRequired)", async () => {
    // A MENTOR signs in without MFA (not required for the role), then is made a PROGRAM_OFFICER
    // behind the service's back. Their existing session must not reach an admin route.
    const mentor = await staff("MENTOR", null);
    const token = await accessTokenFor(app, mentor);
    await platformDb.$executeRaw`UPDATE public."users" SET "role" = 'PROGRAM_OFFICER' WHERE "id" = ${mentor.id}`;
    const directory = await app.inject({ method: "GET", url: "/v1/users/directory", headers: bearer(token) });
    expect(directory.statusCode).toBe(403);
    expect(directory.json<Body>().error).toBe("MfaRequired");
    const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: bearer(token) });
    expect(me.json<Body>().error).toBe("MfaRequired");
    // CONTROL: an MFA-verified PROGRAM_OFFICER reads the same route.
    const officer = await enrolledAdmin("PROGRAM_OFFICER");
    expect((await app.inject({ method: "GET", url: "/v1/users/directory", headers: bearer(officer.token) })).statusCode).toBe(200);
  });

  it("an administrator cannot turn MFA off", async () => {
    const { user, token } = await enrolledAdmin();
    const response = await post("/v1/auth/mfa/disable", { currentPassword: user.password, code: freshCode(user.email) }, bearer(token));
    expect(response.status).toBe(403);
    expect((await platformDb.user.findUniqueOrThrow({ where: { id: user.id } })).mfaEnabled).toBe(true);
  });

  it("the secret, the backup codes and the challenge never reach a log line", async () => {
    const admin = await staff("SUPER_ADMIN", null);
    const { output, result } = await captureOutput(async () => {
      const first = await login(admin);
      const challengeToken = first.body.challengeToken ?? "";
      const start = await post("/v1/auth/login/mfa-enrollment/start", { challengeToken });
      const secret = start.body.secret ?? "";
      const confirm = await post("/v1/auth/login/mfa-enrollment/confirm", { challengeToken, code: totpCodeAt(secret, Date.now()) });
      return { challengeToken, secret, backupCodes: confirm.body.backupCodes ?? [] };
    });
    expect(result.backupCodes).toHaveLength(10);
    for (const secretValue of [result.challengeToken, result.secret, ...result.backupCodes]) {
      expect(output).not.toContain(secretValue);
    }
    // And never comes back from the status read.
    const status = await platformDb.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(status.mfaEnabled).toBe(true);
  });
});

describe("opt-in MFA for a business user", () => {
  it("enrol, then every login needs the code; turning it off needs password AND code", async () => {
    const owner = await staff("MSME_OWNER", fixtureTenantId);
    const plain = await login(owner);
    expect(plain.body.status).toBe("AUTHENTICATED");
    const token = plain.body.accessToken ?? "";
    const status = await app.inject({ method: "GET", url: "/v1/auth/mfa", headers: bearer(token) });
    expect(status.json()).toMatchObject({ enabled: false, required: false, backupCodesRemaining: 0 });
    expect(JSON.stringify(status.json())).not.toContain("secret");

    const setup = await post("/v1/auth/mfa/setup", {}, bearer(token));
    expect(setup.status).toBe(200);
    rememberEnrollment(owner.email, setup.body.secret ?? "", []);
    const confirm = await post("/v1/auth/mfa/confirm", { code: freshCode(owner.email) }, bearer(token));
    expect(confirm.status).toBe(200);
    expect(confirm.body.backupCodes).toHaveLength(10);
    enrollmentOf(owner.email)?.backupCodes.push(...(confirm.body.backupCodes ?? []));
    // Already on: a second setup is refused rather than silently replacing the authenticator.
    expect((await post("/v1/auth/mfa/setup", {}, bearer(token))).status).toBe(409);

    expect((await login(owner)).body.status).toBe("MFA_REQUIRED");

    // Wrong password with a right code: refused, MFA stays on.
    expect((await post("/v1/auth/mfa/disable", { currentPassword: "not-the-password!", code: freshCode(owner.email) }, bearer(token))).status).toBe(401);
    const off = await app.inject({
      method: "POST",
      url: "/v1/auth/mfa/disable",
      headers: bearer(token),
      payload: { currentPassword: owner.password, code: freshCode(owner.email) },
    });
    expect(off.statusCode).toBe(204);
    expect((await login(owner)).body.status).toBe("AUTHENTICATED");
  });

  it("regression: a business user without MFA signs in exactly as before", async () => {
    const cashier = await staff("CASHIER", fixtureTenantId);
    const response = await login(cashier);
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("AUTHENTICATED");
    expect(typeof response.body.accessToken).toBe("string");
    const session = await platformDb.session.findFirstOrThrow({ where: { userId: cashier.id } });
    expect(session.mfaVerifiedAt).toBeNull();
  });
});

describe("forced reset on first login is un-skippable", () => {
  it("no session until a NEW password is set; the issued one stops working", async () => {
    const cashier = await staff("CASHIER", fixtureTenantId);
    await platformDb.user.update({ where: { id: cashier.id }, data: { mustResetPassword: true } });
    const first = await login(cashier);
    expect(first.body.status).toBe("PASSWORD_RESET_REQUIRED");
    expect(first.body.accessToken).toBeUndefined();
    expect(await sessionCount(cashier.id)).toBe(0);
    const challengeToken = first.body.challengeToken ?? "";

    // The issued password cannot be "chosen" again, nor a short one.
    expect((await post("/v1/auth/login/password", { challengeToken, newPassword: cashier.password })).status).toBe(400);
    expect((await post("/v1/auth/login/password", { challengeToken, newPassword: "short" })).status).toBe(400);
    expect(await sessionCount(cashier.id)).toBe(0);

    const fresh = "a-brand-new-password-2026";
    const done = await post("/v1/auth/login/password", { challengeToken, newPassword: fresh });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("AUTHENTICATED");
    expect((await platformDb.user.findUniqueOrThrow({ where: { id: cashier.id } })).mustResetPassword).toBe(false);
    expect((await login(cashier)).status).toBe(401);
    expect((await post("/v1/auth/login", { email: cashier.email, password: fresh })).body.status).toBe("AUTHENTICATED");
    expect(await platformDb.auditLog.count({ where: { action: "PASSWORD_FORCED_RESET_COMPLETED", targetUserId: cashier.id } })).toBe(1);
  });

  it("an account flagged while signed in is locked out at once, and cannot refresh", async () => {
    const cashier = await staff("CASHIER", fixtureTenantId);
    const signedIn = await login(cashier);
    const token = signedIn.body.accessToken ?? "";
    expect((await app.inject({ method: "GET", url: "/v1/auth/me", headers: bearer(token) })).statusCode).toBe(200);
    await platformDb.user.update({ where: { id: cashier.id }, data: { mustResetPassword: true } });
    const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: bearer(token) });
    expect(me.statusCode).toBe(403);
    expect(me.json<Body>().error).toBe("PasswordResetRequired");
    expect((await post("/v1/auth/refresh", { refreshToken: signedIn.body.refreshToken ?? "" })).status).toBe(401);
  });

  it("an administrator with a forced reset resets, then still has to enrol MFA", async () => {
    const admin = await staff("SUPER_ADMIN", null);
    await platformDb.user.update({ where: { id: admin.id }, data: { mustResetPassword: true } });
    const first = await login(admin);
    expect(first.body.status).toBe("PASSWORD_RESET_REQUIRED");
    const next = await post("/v1/auth/login/password", { challengeToken: first.body.challengeToken ?? "", newPassword: "admin-new-password-2026" });
    expect(next.body.status).toBe("MFA_ENROLLMENT_REQUIRED");
    expect(await sessionCount(admin.id)).toBe(0);
  });
});

describe("step-up and admin-assisted recovery", () => {
  it("resetting another user's MFA needs a fresh step-up, exposes nothing, signs them out and is audited", async () => {
    const { user: admin, token } = await enrolledAdmin();
    const { user: target, token: targetToken } = await enrolledAdmin("PROGRAM_OFFICER");

    const refused = await app.inject({ method: "POST", url: `/v1/users/${target.id}/mfa/reset`, headers: bearer(token) });
    expect(refused.statusCode).toBe(403);
    expect(refused.json<Body>().error).toBe("StepUpRequired");

    await stepUp(app, token, admin.email);
    const reset = await app.inject({ method: "POST", url: `/v1/users/${target.id}/mfa/reset`, headers: bearer(token) });
    expect(reset.statusCode).toBe(200);
    expect(reset.body).not.toMatch(/secret|backup/i);
    const row = await platformDb.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.mfaEnabled).toBe(false);
    expect(row.mfaSecretCiphertext).toBeNull();
    expect(await platformDb.mfaBackupCode.count({ where: { userId: target.id } })).toBe(0);
    expect((await app.inject({ method: "GET", url: "/v1/auth/me", headers: bearer(targetToken) })).statusCode).toBe(401);
    expect((await login(target)).body.status).toBe("MFA_ENROLLMENT_REQUIRED");
    expect(await platformDb.auditLog.count({ where: { action: "MFA_RESET", targetUserId: target.id, actorUserId: admin.id } })).toBe(1);

    // Never on yourself.
    const self = await app.inject({ method: "POST", url: `/v1/users/${admin.id}/mfa/reset`, headers: bearer(token) });
    expect(self.statusCode).toBe(403);
  });

  it("a stale step-up is refused", async () => {
    const { user: admin, token } = await enrolledAdmin();
    const target = await staff("CASHIER", fixtureTenantId);
    await stepUp(app, token, admin.email);
    await platformDb.$executeRaw`UPDATE public."sessions" SET "stepUpAt" = now() - interval '10 minutes' WHERE "userId" = ${admin.id}`;
    const response = await app.inject({ method: "POST", url: `/v1/users/${target.id}/password/reset`, headers: bearer(token) });
    expect(response.statusCode).toBe(403);
    expect(response.json<Body>().error).toBe("StepUpRequired");
  });

  it("a step-up is itself a second factor: a replayed code does not open the window", async () => {
    const { user: admin, token } = await enrolledAdmin();
    const code = freshCode(admin.email);
    expect((await post("/v1/auth/mfa/step-up", { code }, bearer(token))).status).toBe(200);
    expect((await post("/v1/auth/mfa/step-up", { code }, bearer(token))).status).toBe(401);
  });

  it("an admin password reset delivers a temporary password ONLY to the user, who must replace it", async () => {
    const { user: admin, token } = await enrolledAdmin();
    const target = await staff("CASHIER", fixtureTenantId);
    const targetSession = await login(target);
    await stepUp(app, token, admin.email);
    const before = simulatedOutbox().length;
    const response = await app.inject({ method: "POST", url: `/v1/users/${target.id}/password/reset`, headers: bearer(token) });
    expect(response.statusCode).toBe(200);
    const message = simulatedOutbox().slice(before).find((sent) => sent.to === target.email);
    const temporary = /Sign in with this temporary password:\n\n(\S+)/.exec(message?.body ?? "")?.[1] ?? "";
    expect(temporary).toHaveLength(16);
    expect(response.body).not.toContain(temporary);
    expect((await app.inject({ method: "GET", url: "/v1/auth/me", headers: bearer(targetSession.body.accessToken ?? "") })).statusCode).toBe(401);
    expect((await login(target)).status).toBe(401);
    const next = await post("/v1/auth/login", { email: target.email, password: temporary });
    expect(next.body.status).toBe("PASSWORD_RESET_REQUIRED");
    expect(await platformDb.auditLog.count({ where: { action: "PASSWORD_ADMIN_RESET", targetUserId: target.id } })).toBe(1);
  });

  it("an owner resets only their own business's users (anyone else is 404)", async () => {
    const owner = await staff("MSME_OWNER", fixtureTenantId);
    const ownerToken = (await login(owner)).body.accessToken ?? "";
    // A user outside the owner's business (a platform user) is invisible to them.
    const outsider = await staff("MENTOR", null);
    const foreign = await app.inject({ method: "POST", url: `/v1/users/${outsider.id}/mfa/reset`, headers: bearer(ownerToken) });
    expect(foreign.statusCode).toBe(404);
    const own = await staff("CASHIER", fixtureTenantId);
    // An owner (who may have no MFA) needs no step-up for their own staff.
    expect((await app.inject({ method: "POST", url: `/v1/users/${own.id}/mfa/reset`, headers: bearer(ownerToken) })).statusCode).toBe(200);
    // A manager may not do it at all.
    const manager = await staff("MSME_MANAGER", fixtureTenantId);
    const managerToken = (await login(manager)).body.accessToken ?? "";
    expect((await app.inject({ method: "POST", url: `/v1/users/${own.id}/mfa/reset`, headers: bearer(managerToken) })).statusCode).toBe(403);
  });
});

describe("sessions: list and revoke one", () => {
  it("revokes exactly one own session; another account's session id is 404", async () => {
    const cashier = await staff("CASHIER", fixtureTenantId);
    const a = (await login(cashier)).body.accessToken ?? "";
    const b = (await login(cashier)).body.accessToken ?? "";
    const list = await app.inject({ method: "GET", url: "/v1/auth/sessions", headers: bearer(a) });
    const sessions = list.json<{ data: Array<{ id: string; current: boolean }> }>().data;
    expect(sessions).toHaveLength(2);
    const other = sessions.find((session) => !session.current);
    expect(other).toBeDefined();
    expect((await app.inject({ method: "DELETE", url: `/v1/auth/sessions/${other?.id ?? ""}`, headers: bearer(a) })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/v1/auth/me", headers: bearer(b) })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/auth/me", headers: bearer(a) })).statusCode).toBe(200);

    const stranger = await staff("CASHIER", fixtureTenantId);
    const strangerToken = (await login(stranger)).body.accessToken ?? "";
    const mine = sessions.find((session) => session.current)?.id ?? "";
    expect((await app.inject({ method: "DELETE", url: `/v1/auth/sessions/${mine}`, headers: bearer(strangerToken) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/auth/me", headers: bearer(a) })).statusCode).toBe(200);
  });
});

describe("the database guarantees, attacked from raw SQL", () => {
  it("refuses an admin session without mfaVerifiedAt (control: with it, accepted)", async () => {
    const admin = await staff("SUPER_ADMIN", null);
    await withPlatformTx(async (client) => {
      await expectDbRefusal(
        client.query(
          `INSERT INTO public.sessions ("id","userId","refreshTokenHash","expiresAt") VALUES (gen_random_uuid()::text, $1, md5(random()::text), now() + interval '1 day')`,
          [admin.id],
        ),
        { fn: "session_mfa_guard", message: /must be MFA-verified/ },
      );
    });
    await withPlatformTx(async (client) => {
      await client.query(
        `INSERT INTO public.sessions ("id","userId","refreshTokenHash","expiresAt","mfaVerifiedAt") VALUES (gen_random_uuid()::text, $1, md5(random()::text), now() + interval '1 day', now())`,
        [admin.id],
      );
    });
  });

  it("refuses removing a session's MFA stamp, and a step-up on an unverified session", async () => {
    const { user } = await enrolledAdmin();
    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(`UPDATE public.sessions SET "mfaVerifiedAt" = NULL WHERE "userId" = $1`, [user.id]), {
        fn: "session_mfa_guard",
        message: /can never be removed/,
      });
    });
    const cashier = await staff("CASHIER", fixtureTenantId);
    await login(cashier);
    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(`UPDATE public.sessions SET "stepUpAt" = now() WHERE "userId" = $1`, [cashier.id]), {
        constraint: "session_step_up_needs_mfa",
        code: "23514",
      });
    });
  });

  it("refuses moving the replay guard backwards (control: forwards is accepted)", async () => {
    const { user } = await enrolledAdmin();
    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(`UPDATE public.users SET "mfaLastUsedStep" = "mfaLastUsedStep" - 5 WHERE "id" = $1`, [user.id]), {
        fn: "user_mfa_step_guard",
        message: /only move forward/,
      });
    });
    await withPlatformTx(async (client) => {
      await client.query(`UPDATE public.users SET "mfaLastUsedStep" = "mfaLastUsedStep" + 1 WHERE "id" = $1`, [user.id]);
    });
  });

  it("refuses MFA switched on without a secret", async () => {
    const cashier = await staff("CASHIER", fixtureTenantId);
    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(`UPDATE public.users SET "mfaEnabled" = true, "mfaEnrolledAt" = now() WHERE "id" = $1`, [cashier.id]), {
        constraint: "user_mfa_enabled_has_secret",
        code: "23514",
      });
    });
  });

  it("refuses un-using a backup code (control: burning an unused one)", async () => {
    const { user } = await enrolledAdmin();
    await withPlatformTx(async (client) => {
      const { rows } = await client.query<{ id: string }>(`SELECT "id" FROM public.mfa_backup_codes WHERE "userId" = $1 LIMIT 1`, [user.id]);
      const id = rows[0]?.id ?? "";
      await client.query(`UPDATE public.mfa_backup_codes SET "usedAt" = now() WHERE "id" = $1`, [id]);
      await expectDbRefusal(client.query(`UPDATE public.mfa_backup_codes SET "usedAt" = NULL WHERE "id" = $1`, [id]), {
        fn: "mfa_backup_code_guard",
        message: /single-use/,
      });
    });
  });

  it("refuses re-opening a challenge stage or clearing MFA without the factor (control: a legal clear)", async () => {
    const { user } = await enrolledAdmin();
    const challenge = await login(user);
    const tokenHash = hashSecretToken(challenge.body.challengeToken ?? "");
    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(`UPDATE public.login_challenges SET "needsMfa" = false WHERE "tokenHash" = $1`, [tokenHash]), {
        fn: "login_challenge_guard",
        message: /clears only with the factor proven/,
      });
    });
    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(`UPDATE public.login_challenges SET "needsPasswordReset" = true WHERE "tokenHash" = $1`, [tokenHash]), {
        fn: "login_challenge_guard",
        message: /can never be re-opened/,
      });
    });
    await withPlatformTx(async (client) => {
      await client.query(`UPDATE public.login_challenges SET "needsMfa" = false, "mfaVerified" = true WHERE "tokenHash" = $1`, [tokenHash]);
    });
  });
});
