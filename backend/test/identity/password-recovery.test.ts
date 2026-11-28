// ===========================================================================
// ACCOUNT RECOVERY (Task T-A4), driven through the REAL app (buildServer + inject).
//
// * POST /v1/auth/password/forgot is ENUMERATION-SAFE: an existing and a missing
//   email get byte-identical answers.
// * A reset code is delivered once through the notification channel (T-A3) and the
//   database holds only its sha256.
// * POST /v1/auth/password/reset consumes the code ONCE, enforces the 10-character
//   policy, sets passwordUpdatedAt, revokes EVERY session, and refuses an unknown,
//   used or expired code with the single error shape.
// * Each path writes the right audit row; no raw code or password reaches a log line.
// * The single-use guarantee holds against raw SQL (`password_reset_token_guard`).
// ===========================================================================

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { platformDb } from "../../src/db/platform";
import { errorBody } from "../../src/schemas/common";
import { buildServer } from "../../src/server";
import { hashSecretToken } from "../../src/services/identity/secret-token";
import { simulatedOutbox } from "../../src/services/notifications/simulated-provider";
import { expectDbRefusal } from "../support/db-errors";
import { captureOutput } from "../support/log-capture";
import { withPlatformTx } from "../support/platform-tx";
import { accessTokenFor, createFixtureUser, deleteUsers, freshIp, type TestUser } from "../security/http-app";

const NEUTRAL = { message: "If an account exists for that email, a reset code has been sent to it." };
const INVALID_CODE = errorBody(400, "BadRequest", "This reset code is invalid or has expired. Request a new one.");

let app: FastifyInstance;
const users: TestUser[] = [];

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await deleteUsers(users);
  await app.close();
});

async function newUser(): Promise<TestUser> {
  const user = await createFixtureUser("MSME_MANAGER");
  users.push(user);
  return user;
}

async function forgot(email: string) {
  return app.inject({ method: "POST", url: "/v1/auth/password/forgot", remoteAddress: freshIp(), payload: { email } });
}

async function reset(token: string, newPassword: string) {
  return app.inject({ method: "POST", url: "/v1/auth/password/reset", remoteAddress: freshIp(), payload: { token, newPassword } });
}

async function login(email: string, password: string) {
  return app.inject({ method: "POST", url: "/v1/auth/login", remoteAddress: freshIp(), payload: { email, password } });
}

/** Requests a reset and returns the raw code the simulator "delivered" to the user. */
async function requestCode(user: TestUser): Promise<string> {
  const before = simulatedOutbox().length;
  expect((await forgot(user.email)).statusCode).toBe(202);
  // Delivery runs off the request path: wait for it to land.
  return vi.waitFor(() => {
    const message = simulatedOutbox()
      .slice(before)
      .find((candidate) => candidate.to === user.email);
    if (message === undefined) throw new Error("reset code not delivered yet");
    const code = /\n\n([A-Za-z0-9_-]{20,})\n\n/.exec(message.body)?.[1];
    if (code === undefined) throw new Error("no code in the delivered body");
    return code;
  });
}

describe("POST /password/forgot is enumeration-safe", () => {
  it("an existing and a missing email get the IDENTICAL status, body and content type", async () => {
    const user = await newUser();
    const hit = await forgot(user.email);
    const miss = await forgot(`nobody-${randomUUID()}@test.invalid`);
    expect(hit.statusCode).toBe(202);
    expect(miss.statusCode).toBe(hit.statusCode);
    expect(miss.body).toBe(hit.body);
    expect(hit.json()).toEqual(NEUTRAL);
    expect(miss.headers["content-type"]).toBe(hit.headers["content-type"]);
  });

  it("a deactivated account is answered exactly like a missing one", async () => {
    const user = await newUser();
    await platformDb.user.update({ where: { id: user.id }, data: { isActive: false } });
    const response = await forgot(user.email);
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual(NEUTRAL);
    expect(await platformDb.passwordResetToken.count({ where: { userId: user.id } })).toBe(0);
  });

  it("a hit stores ONLY the code's sha256, delivers the raw code once, and audits the request", async () => {
    const user = await newUser();
    const code = await requestCode(user);
    const tokens = await platformDb.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.tokenHash).toBe(hashSecretToken(code));
    expect(JSON.stringify(tokens)).not.toContain(code);

    const log = await platformDb.notificationLog.findFirstOrThrow({
      where: { relatedType: "PasswordResetToken", relatedId: tokens[0]?.id ?? "" },
    });
    expect(log).toMatchObject({ channel: "EMAIL", recipient: user.email, templateKey: "password-reset", status: "SIMULATED" });

    const audit = await platformDb.auditLog.findFirstOrThrow({
      where: { action: "PASSWORD_RESET_REQUESTED", targetUserId: user.id },
    });
    expect(audit).toMatchObject({ actorUserId: null, metadata: { email: user.email, matched: true } });
    expect(JSON.stringify(audit)).not.toContain(code);
  });

  it("SMS is first-class: an account with a phone also gets the SAME code by SMS", async () => {
    const user = await newUser();
    const phone = `+2547${Math.floor(10_000_000 + Math.random() * 89_999_999).toString()}`;
    await platformDb.user.update({ where: { id: user.id }, data: { phone } });
    const before = simulatedOutbox().length;
    expect((await forgot(user.email)).statusCode).toBe(202);
    const [email, sms] = await vi.waitFor(() => {
      const delivered = simulatedOutbox().slice(before);
      const byEmail = delivered.find((message) => message.to === user.email);
      const bySms = delivered.find((message) => message.to === phone);
      if (byEmail === undefined || bySms === undefined) throw new Error("not delivered on both channels yet");
      return [byEmail, bySms] as const;
    });
    expect(sms.channel).toBe("SMS");
    const code = /\n\n([A-Za-z0-9_-]{20,})\n\n/.exec(email.body)?.[1] ?? "missing";
    expect(sms.body).toContain(code);
    expect(await platformDb.passwordResetToken.count({ where: { userId: user.id } })).toBe(1);
  });

  it("a miss is audited too, with no target", async () => {
    const email = `nobody-${randomUUID()}@test.invalid`;
    await forgot(email);
    const audit = await platformDb.auditLog.findFirstOrThrow({
      where: { action: "PASSWORD_RESET_REQUESTED", metadata: { path: ["email"], equals: email } },
    });
    expect(audit).toMatchObject({ actorUserId: null, targetUserId: null, metadata: { email, matched: false } });
  });
});

describe("POST /password/reset", () => {
  it("resets the password, sets passwordUpdatedAt, revokes EVERY session, and audits it", async () => {
    const user = await newUser();
    const existingToken = await accessTokenFor(app, user);
    const me = () => app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${existingToken}` } });
    expect((await me()).statusCode).toBe(200);

    const code = await requestCode(user);
    const newPassword = `Fresh-${randomUUID()}`;
    const { result: response, output } = await captureOutput(() => reset(code, newPassword));
    expect(response.statusCode).toBe(204);

    const row = await platformDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.passwordUpdatedAt).toBeInstanceOf(Date);
    // A pre-existing session no longer authenticates; nobody was signed in.
    expect((await me()).statusCode).toBe(401);
    expect(await platformDb.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    // The old password is dead; the new one works.
    expect((await login(user.email, user.password)).statusCode).toBe(401);
    expect((await login(user.email, newPassword)).statusCode).toBe(200);

    const audit = await platformDb.auditLog.findFirstOrThrow({ where: { action: "PASSWORD_RESET_COMPLETED", targetUserId: user.id } });
    expect(audit).toMatchObject({ actorUserId: user.id });
    // Neither the code nor the new password reached a log line. (The request IS in the
    // captured output, so the capture saw the request log at all.)
    expect(output).toContain("/v1/auth/password/reset");
    expect(output).not.toContain(code);
    expect(output).not.toContain(newPassword);
  });

  it("a code is SINGLE-USE: the second use is refused with the single error shape", async () => {
    const user = await newUser();
    const code = await requestCode(user);
    expect((await reset(code, `First-${randomUUID()}`)).statusCode).toBe(204);
    const second = await reset(code, `Second-${randomUUID()}`);
    expect(second.statusCode).toBe(400);
    expect(second.json()).toStrictEqual(INVALID_CODE);
  });

  it("a code EXPIRES: past its TTL it is refused, and it was never consumed", async () => {
    const user = await newUser();
    const code = await requestCode(user);
    const ttlMinutes = Number(process.env["PASSWORD_RESET_TTL_MINUTES"] ?? "60");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + (ttlMinutes + 1) * 60_000);
    const late = await reset(code, `Late-${randomUUID()}`);
    expect(late.statusCode).toBe(400);
    expect(late.json()).toStrictEqual(INVALID_CODE);
    const token = await platformDb.passwordResetToken.findUniqueOrThrow({ where: { tokenHash: hashSecretToken(code) } });
    expect(token.usedAt).toBeNull();
  });

  it("enforces the 10-character policy — and a refused password does not consume the code", async () => {
    const user = await newUser();
    const code = await requestCode(user);
    const short = await reset(code, "short-pw");
    expect(short.statusCode).toBe(400);
    expect(short.json()).toMatchObject({ statusCode: 400, error: "BadRequest" });
    expect(short.json<{ message: string }>().message).toMatch(/at least 10 characters/);
    expect((await reset(code, `LongEnough-${randomUUID()}`)).statusCode).toBe(204);
  });

  it("an unknown code is refused with the same shape and message", async () => {
    const response = await reset("not-a-real-code-0000000000000000", `Whatever-${randomUUID()}`);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toStrictEqual(INVALID_CODE);
  });
});

describe("the reset token's database guarantees (raw SQL)", () => {
  async function insertToken(client: import("pg").PoolClient, userId: string): Promise<string> {
    const id = randomUUID();
    await client.query(
      `INSERT INTO public.password_reset_tokens ("id", "userId", "tokenHash", "expiresAt") VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [id, userId, hashSecretToken(randomUUID())],
    );
    return id;
  }

  it("control: an unused token can be consumed once", async () => {
    const user = await newUser();
    await withPlatformTx(async (client) => {
      const id = await insertToken(client, user.id);
      await client.query(`UPDATE public.password_reset_tokens SET "usedAt" = now() WHERE "id" = $1`, [id]);
    });
  });

  it("a used token cannot be un-used or re-used", async () => {
    const user = await newUser();
    await withPlatformTx(async (client) => {
      const id = await insertToken(client, user.id);
      await client.query(`UPDATE public.password_reset_tokens SET "usedAt" = now() WHERE "id" = $1`, [id]);
      await expectDbRefusal(client.query(`UPDATE public.password_reset_tokens SET "usedAt" = NULL WHERE "id" = $1`, [id]), {
        fn: "password_reset_token_guard",
        message: /single-use/,
      });
    });
  });

  it("a token's owner, hash and expiry are frozen", async () => {
    const user = await newUser();
    await withPlatformTx(async (client) => {
      const id = await insertToken(client, user.id);
      await expectDbRefusal(
        client.query(`UPDATE public.password_reset_tokens SET "expiresAt" = now() + interval '10 years' WHERE "id" = $1`, [id]),
        { fn: "password_reset_token_guard", message: /can never change/ },
      );
    });
  });

  it("only a sha256 hex digest can be stored, never a raw token", async () => {
    const user = await newUser();
    await withPlatformTx(async (client) => {
      await expectDbRefusal(
        client.query(
          `INSERT INTO public.password_reset_tokens ("id", "userId", "tokenHash", "expiresAt") VALUES ($1, $2, 'raw-token-value', now() + interval '1 hour')`,
          [randomUUID(), user.id],
        ),
        { constraint: "password_reset_token_hash_is_sha256", code: "23514" },
      );
    });
  });
});
