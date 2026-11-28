// ===========================================================================
// JOB TRIGGER AUTHENTICATION (M4.5 W5).
//
// The MACHINE trigger (POST /v1/internal/jobs/{name}/run) accepts either the shared secret or a
// Google-signed OIDC ID token — proven with a locally generated RSA key standing in for Google's,
// served through the JWKS source: a valid token runs the job; a wrong audience, a non-Google
// issuer, a bad signature, an unknown key, an expired token, the wrong service account and an
// administrator's SESSION token are all the same bare 404. The shared secret still works.
//
// The CONSOLE run (POST /v1/jobs/{name}/run) is a SUPER_ADMIN session behind an MFA step-up, needs an
// idempotency key (same key, same run), and records trigger CONSOLE with the administrator; the
// database pins CONSOLE <=> a requester.
// ===========================================================================

import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { platformDb } from "../../src/db/platform";
import { buildServer } from "../../src/server";
import { clearJwksCache, jwksSource } from "../../src/services/jobs/oidc";
import { retryBackoff } from "../../src/services/jobs/runner";
import { bearer, createStaffUser, signIn, type SignedIn, type StaffUser } from "../identity/staff-fixture";
import { freshIp } from "../security/http-app";
import { tenantIdOf } from "../setup/tenant";
import { expectDbRefusal } from "../support/db-errors";
import { stepUp } from "../support/mfa";
import { withPlatformTx } from "../support/platform-tx";

const AUDIENCE = "https://api.angaza360.test/v1/internal/jobs";
const ACCOUNT = "scheduler@angaza-test.iam.gserviceaccount.com";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: otherKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-key-1";

let app: FastifyInstance;
const users: StaffUser[] = [];
let admin: SignedIn;
let officer: SignedIn;
let owner: SignedIn;
let fetches = 0;
const realFetch = jwksSource.fetch;

function token(claims: Record<string, unknown>, opts: { key?: typeof privateKey; kid?: string; alg?: string } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: opts.alg ?? "RS256", kid: opts.kid ?? KID, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: AUDIENCE, email: ACCOUNT, email_verified: true, iat: now, exp: now + 600, ...claims })).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), opts.key ?? privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

const machine = (headers: Record<string, string>, key?: string) =>
  app.inject({ method: "POST", url: "/v1/internal/jobs/expire-tokens/run", remoteAddress: freshIp(), headers: { ...headers, ...(key ? { "idempotency-key": key } : {}) } });

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  for (const [role, tenant] of [["SUPER_ADMIN", null], ["PROGRAM_OFFICER", null], ["MSME_OWNER", await tenantIdOf()]] as const) {
    const user = await createStaffUser(role, tenant);
    users.push(user);
  }
  admin = await signIn(app, users[0] as StaffUser);
  officer = await signIn(app, users[1] as StaffUser);
  owner = await signIn(app, users[2] as StaffUser);
});

beforeEach(() => {
  retryBackoff.ms = () => 0;
  process.env.JOB_TRIGGER_OIDC_AUDIENCE = AUDIENCE;
  process.env.JOB_TRIGGER_OIDC_SERVICE_ACCOUNT = ACCOUNT;
  delete process.env.JOB_TRIGGER_SECRET;
  clearJwksCache();
  fetches = 0;
  jwksSource.fetch = async () => {
    fetches += 1;
    return { jwks: { keys: [{ ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" }] }, maxAgeSeconds: 3600 };
  };
});

afterEach(() => {
  jwksSource.fetch = realFetch;
  delete process.env.JOB_TRIGGER_OIDC_AUDIENCE;
  delete process.env.JOB_TRIGGER_OIDC_SERVICE_ACCOUNT;
  delete process.env.JOB_TRIGGER_SECRET;
});

afterAll(async () => {
  await platformDb.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await app.close();
});

describe("the machine trigger: Google OIDC or the shared secret", () => {
  it("runs the job for a valid Google-signed token, and caches Google's keys", async () => {
    const response = await machine({ authorization: `Bearer ${token({})}` }, `oidc:${randomBytes(4).toString("hex")}`);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string; trigger: string; requestedBy: string | null }>()).toMatchObject({ status: "SUCCEEDED", trigger: "SCHEDULER", requestedBy: null });
    await machine({ authorization: `Bearer ${token({})}` }, `oidc:${randomBytes(4).toString("hex")}`);
    expect(fetches).toBe(1);
  });

  it("404s a wrong audience, a non-Google issuer, a bad signature, an unknown key, an expired token or the wrong account", async () => {
    const now = Math.floor(Date.now() / 1000);
    const bad: Array<[string, string]> = [
      ["audience", token({ aud: "https://someone-else.example" })],
      ["issuer", token({ iss: "https://evil.example" })],
      ["signature", token({}, { key: otherKey })],
      ["key id", token({}, { kid: "not-a-google-key" })],
      ["algorithm", token({}, { alg: "HS256" })],
      ["expired", token({ iat: now - 7200, exp: now - 3600 })],
      ["account", token({ email: "intruder@evil.iam.gserviceaccount.com" })],
      ["unverified", token({ email_verified: false })],
      ["tampered", `${token({}).split(".").slice(0, 1).join(".")}.${Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: AUDIENCE, email: ACCOUNT, email_verified: true, exp: now + 600 })).toString("base64url")}.${token({}).split(".")[2] ?? ""}`],
    ];
    for (const [what, jwt] of bad) {
      const response = await machine({ authorization: `Bearer ${jwt}` });
      expect([what, response.statusCode]).toEqual([what, 404]);
      expect(response.json<{ message: string }>().message).toBe("Not found.");
    }
  });

  it("a session token is not a machine credential: an administrator's session is a bare 404", async () => {
    expect((await machine({ authorization: `Bearer ${admin.token}` })).statusCode).toBe(404);
  });

  it("with no audience configured the OIDC path is off — even a valid token is 404", async () => {
    delete process.env.JOB_TRIGGER_OIDC_AUDIENCE;
    expect((await machine({ authorization: `Bearer ${token({})}` })).statusCode).toBe(404);
  });

  it("the shared secret still works, and a key replays to the same run", async () => {
    const secret = randomBytes(24).toString("hex");
    process.env.JOB_TRIGGER_SECRET = secret;
    const key = `secret:${randomBytes(4).toString("hex")}`;
    const first = await machine({ "x-job-trigger-secret": secret }, key);
    expect(first.statusCode).toBe(200);
    const again = await machine({ "x-job-trigger-secret": secret }, key);
    expect(again.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
    expect((await machine({ "x-job-trigger-secret": `${secret}x` })).statusCode).toBe(404);
  });
});

describe("the console run: SUPER_ADMIN, MFA step-up, idempotent, recorded", () => {
  const consoleRun = (who: SignedIn, key?: string) =>
    app.inject({ method: "POST", url: "/v1/jobs/expire-tokens/run", remoteAddress: freshIp(), headers: { ...bearer(who.token), ...(key ? { "idempotency-key": key } : {}) } });

  it("requires a fresh step-up, a key, and the SUPER_ADMIN role", async () => {
    const key = `click-${randomBytes(6).toString("hex")}`;
    const noStepUp = await consoleRun(admin, key);
    expect(noStepUp.statusCode).toBe(403);
    expect(noStepUp.json<{ error: string }>().error).toBe("StepUpRequired");
    expect((await consoleRun(officer, key)).statusCode).toBe(403);
    expect((await consoleRun(owner, key)).statusCode).toBe(403);
    await stepUp(app, admin.token, admin.user.email);
    expect((await consoleRun(admin)).statusCode).toBe(400);
  });

  it("records trigger CONSOLE with the administrator; the same key is the same run", async () => {
    await stepUp(app, admin.token, admin.user.email);
    const key = `click-${randomBytes(6).toString("hex")}`;
    const first = await consoleRun(admin, key);
    expect(first.statusCode).toBe(200);
    expect(first.json<{ trigger: string; requestedBy: string; status: string }>()).toMatchObject({ trigger: "CONSOLE", requestedBy: admin.user.id, status: "SUCCEEDED" });
    const again = await consoleRun(admin, key);
    expect(again.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
    expect(await platformDb.jobRun.count({ where: { idempotencyKey: `console:${key}` } })).toBe(1);
  });

  it("the console route cannot be reached with the machine secret", async () => {
    const secret = randomBytes(24).toString("hex");
    process.env.JOB_TRIGGER_SECRET = secret;
    const response = await app.inject({ method: "POST", url: "/v1/jobs/expire-tokens/run", remoteAddress: freshIp(), headers: { "x-job-trigger-secret": secret, "idempotency-key": "machine-key-123" } });
    expect(response.statusCode).toBe(401);
  });

  it("the database pins CONSOLE to a requester, both ways", async () => {
    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(`INSERT INTO public.job_runs ("id","jobName","trigger","idempotencyKey","status") VALUES (gen_random_uuid()::text,'expire-tokens','CONSOLE','raw-${randomBytes(4).toString("hex")}','RUNNING')`), { constraint: "job_runs_console_names_requester" });
    });
    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(`INSERT INTO public.job_runs ("id","jobName","trigger","idempotencyKey","status","requestedBy") VALUES (gen_random_uuid()::text,'expire-tokens','CLI','raw-${randomBytes(4).toString("hex")}','RUNNING','someone')`), { constraint: "job_runs_console_names_requester" });
    });
  });
});
