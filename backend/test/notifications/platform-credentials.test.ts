// ===========================================================================
// ANGAZA'S OWN NOTIFICATION CREDENTIALS, MANAGED FROM THE COMMAND CENTER (M4.5 W5).
//
// Proven: storing, activating and deactivating need a SUPER_ADMIN AFTER an MFA step-up; storing is
// a rotation (PENDING, UNVERIFIED); NO route ever returns a field value — a sentinel password and
// API key are searched for in every response, including a verify whose provider echoes the key
// back; verifying is idempotent and changes only the health record; every change and verify is
// audited without a value; and a platform administrator CANNOT view, activate or verify a
// business's M-Pesa / eTIMS credentials through any path. The health CHECK is attacked from raw SQL.
// ===========================================================================

import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformDb } from "../../src/db/platform";
import { buildServer } from "../../src/server";
import { probeDeps } from "../../src/services/notifications/platform-credentials";
import type { SmtpTransportFactory } from "../../src/services/notifications/smtp-provider";
import { bearer, createStaffUser, signIn, type SignedIn, type StaffUser } from "../identity/staff-fixture";
import { freshIp } from "../security/http-app";
import { tenantIdOf } from "../setup/tenant";
import { expectDbRefusal } from "../support/db-errors";
import { stepUp } from "../support/mfa";
import { withPlatformTx } from "../support/platform-tx";

const PASSWORD = `smtp-pass-${randomBytes(8).toString("hex")}`;
const API_KEY = `SG.${randomBytes(12).toString("hex")}`;
const SECRETS = [PASSWORD, API_KEY];

let app: FastifyInstance;
const users: StaffUser[] = [];
let admin: SignedIn;
let officer: SignedIn;
let owner: SignedIn;
const realFetch = probeDeps.fetch;

const call = (method: "GET" | "PUT" | "POST", url: string, who: SignedIn, body?: unknown) =>
  app.inject({ method, url: `/v1/platform-credentials${url}`, remoteAddress: freshIp(), headers: bearer(who.token), ...(body !== undefined ? { payload: body as object } : {}) });

function leaks(text: string): string[] {
  return SECRETS.filter((secret) => text.includes(secret));
}

const smtpFields = { host: "smtp.example.test", port: "587", username: "mailer@angaza.test", password: PASSWORD, fromEmail: "no-reply@angaza.test", fromName: "Angaza360" };

function transport(outcome: "ok" | "fail"): SmtpTransportFactory {
  const fake = () => ({
    verify: async () => {
      if (outcome === "ok") return true;
      // A server that echoes the AUTH exchange: the message carries the password.
      throw Object.assign(new Error(`535 auth failed for ${PASSWORD}`), { code: "EAUTH", responseCode: 535 });
    },
    close: () => undefined,
  });
  return fake as unknown as SmtpTransportFactory;
}

async function clean(): Promise<void> {
  await platformDb.platformIntegrationCredential.deleteMany({ where: { provider: { in: ["SMTP", "SENDGRID", "AFRICASTALKING"] } } });
}

beforeAll(async () => {
  await clean();
  app = await buildServer();
  await app.ready();
  for (const [role, tenant] of [["SUPER_ADMIN", null], ["PROGRAM_OFFICER", null], ["MSME_OWNER", await tenantIdOf()]] as const) users.push(await createStaffUser(role, tenant));
  admin = await signIn(app, users[0] as StaffUser);
  officer = await signIn(app, users[1] as StaffUser);
  owner = await signIn(app, users[2] as StaffUser);
});

afterAll(async () => {
  probeDeps.fetch = realFetch;
  probeDeps.createTransport = undefined;
  await clean();
  await platformDb.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await app.close();
});

describe("storing, activating, verifying", () => {
  it("storing needs a step-up; it is a rotation to PENDING and echoes no value", async () => {
    const refused = await call("PUT", "/SMTP/sandbox", admin, { fields: smtpFields, label: "Mailer" });
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: string }>().error).toBe("StepUpRequired");
    await stepUp(app, admin.token, admin.user.email);
    const stored = await call("PUT", "/SMTP/sandbox", admin, { fields: smtpFields, label: "Mailer" });
    expect(stored.statusCode).toBe(200);
    expect(stored.json<{ status: string; healthStatus: string; updatedById: string }>()).toMatchObject({ status: "PENDING", healthStatus: "UNVERIFIED", updatedById: admin.user.id });
    expect(leaks(stored.body)).toEqual([]);
    // A shape the provider cannot use is never stored.
    const broken = await call("PUT", "/SMTP/production", admin, { fields: { host: "x" } });
    expect(broken.statusCode).toBe(400);
    expect(await platformDb.platformIntegrationCredential.count({ where: { provider: "SMTP", environment: "production" } })).toBe(0);
  });

  it("lists every slot as a safe view — no value, no field name", async () => {
    const list = await call("GET", "/", admin);
    expect(list.statusCode).toBe(200);
    const body = list.json<{ data: Array<{ provider: string; environment: string; credential: Record<string, unknown> | null }>; activeEnvironment: string }>();
    expect(body.data).toHaveLength(6);
    expect(body.activeEnvironment).toBe("sandbox");
    const smtp = body.data.find((s) => s.provider === "SMTP" && s.environment === "sandbox")?.credential ?? {};
    expect(Object.keys(smtp).some((k) => ["ciphertext", "iv", "authTag", "fields", "password", "host"].includes(k))).toBe(false);
    expect(leaks(list.body)).toEqual([]);
  });

  it("activates and deactivates behind a step-up; a repeated move is a 409", async () => {
    await stepUp(app, admin.token, admin.user.email);
    expect((await call("POST", "/SMTP/sandbox/activate", admin)).json<{ status: string }>().status).toBe("ACTIVE");
    expect((await call("POST", "/SMTP/sandbox/activate", admin)).statusCode).toBe(409);
    expect((await call("POST", "/SMTP/sandbox/deactivate", admin)).json<{ status: string }>().status).toBe("INACTIVE");
    expect((await call("POST", "/SENDGRID/production/activate", admin)).statusCode).toBe(404);
  });

  it("verify records the outcome, is idempotent, and never leaks a value — even when the provider echoes it", async () => {
    probeDeps.createTransport = transport("ok");
    const ok = await call("POST", "/SMTP/sandbox/verify", admin);
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ ok: boolean; credential: { healthStatus: string; status: string } }>()).toMatchObject({ ok: true, credential: { healthStatus: "HEALTHY", status: "INACTIVE" } });
    const again = await call("POST", "/SMTP/sandbox/verify", admin);
    expect(again.json<{ credential: { healthStatus: string; status: string } }>().credential).toMatchObject({ healthStatus: "HEALTHY", status: "INACTIVE" });

    probeDeps.createTransport = transport("fail");
    const failing = await call("POST", "/SMTP/sandbox/verify", admin);
    expect(failing.json<{ ok: boolean; detail: string; credential: { healthStatus: string } }>()).toMatchObject({ ok: false, credential: { healthStatus: "FAILING" } });
    expect(leaks(failing.body)).toEqual([]);

    // SendGrid answering 401 with the key in its body: the detail is still clean.
    await stepUp(app, admin.token, admin.user.email);
    await call("PUT", "/SENDGRID/sandbox", admin, { fields: { apiKey: API_KEY, fromEmail: "no-reply@angaza.test" } });
    probeDeps.fetch = async () => new Response(JSON.stringify({ errors: [{ message: `bad key ${API_KEY}` }] }), { status: 401 });
    const refused = await call("POST", "/SENDGRID/sandbox/verify", admin);
    expect(refused.json<{ ok: boolean; detail: string }>()).toMatchObject({ ok: false, detail: "SendGrid refused the credentials (HTTP 401)." });
    expect(leaks(refused.body)).toEqual([]);
    const row = await platformDb.platformIntegrationCredential.findFirstOrThrow({ where: { provider: "SENDGRID", environment: "sandbox" } });
    expect(leaks(row.lastHealthError ?? "")).toEqual([]);
    probeDeps.fetch = realFetch;
  });

  it("every change and verify is audited, and no audit row carries a value", async () => {
    const rows = await platformDb.auditLog.findMany({ where: { actorUserId: admin.user.id, action: { in: ["PLATFORM_CREDENTIAL_STORED", "PLATFORM_CREDENTIAL_ACTIVATED", "PLATFORM_CREDENTIAL_DEACTIVATED", "PLATFORM_CREDENTIAL_VERIFIED"] } } });
    expect(new Set(rows.map((r) => r.action))).toEqual(new Set(["PLATFORM_CREDENTIAL_STORED", "PLATFORM_CREDENTIAL_ACTIVATED", "PLATFORM_CREDENTIAL_DEACTIVATED", "PLATFORM_CREDENTIAL_VERIFIED"]));
    expect(leaks(JSON.stringify(rows.map((r) => r.metadata)))).toEqual([]);
  });
});

describe("who may — and what no one may", () => {
  it("is SUPER_ADMIN only: a programme officer and an owner are refused", async () => {
    for (const who of [officer, owner]) {
      expect((await call("GET", "/", who)).statusCode).toBe(403);
      expect((await call("POST", "/SMTP/sandbox/verify", who)).statusCode).toBe(403);
    }
  });

  it("a platform administrator cannot view, activate or verify a business's M-Pesa or eTIMS credentials through any path", async () => {
    await stepUp(app, admin.token, admin.user.email);
    const business = [
      ["GET", "/v1/integrations/"],
      ["GET", "/v1/integrations/MPESA/credentials/SANDBOX"],
      ["POST", "/v1/integrations/MPESA/credentials/SANDBOX/activate"],
      ["POST", "/v1/integrations/ETIMS/verify"],
      ["GET", "/v1/integrations/health"],
    ] as const;
    for (const [method, url] of business) {
      const response = await app.inject({ method, url, remoteAddress: freshIp(), headers: bearer(admin.token), ...(method === "POST" ? { payload: {} } : {}) });
      expect([url, response.statusCode]).toEqual([url, 403]);
    }
    // The platform panel's provider list cannot name a business's integration.
    for (const provider of ["MPESA", "ETIMS"]) {
      expect((await call("POST", `/${provider}/sandbox/verify`, admin)).statusCode).toBe(400);
      expect((await call("PUT", `/${provider}/sandbox`, admin, { fields: { consumerKey: "x" } })).statusCode).toBe(400);
    }
  });
});

describe("the database pins the credential's shape", () => {
  it("refuses an unknown status and an incoherent health record; the coherent record is accepted", async () => {
    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(`UPDATE public.platform_integration_credentials SET "status" = 'LIVE' WHERE "provider" = 'SMTP'`), { constraint: "platform_credential_status_known" });
    });
    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(`UPDATE public.platform_integration_credentials SET "healthStatus" = 'FAILING', "lastHealthError" = NULL WHERE "provider" = 'SMTP'`), { constraint: "platform_credential_health_coherent" });
    });
    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(`UPDATE public.platform_integration_credentials SET "healthStatus" = 'BROKEN' WHERE "provider" = 'SMTP'`), { constraint: "platform_credential_health_coherent" });
    });
    await withPlatformTx(async (client) => {
      const result = await client.query(`UPDATE public.platform_integration_credentials SET "healthStatus" = 'FAILING', "lastHealthCheckAt" = now(), "lastHealthError" = 'timed out' WHERE "provider" = 'SMTP'`);
      expect(result.rowCount).toBeGreaterThan(0);
    });
  });
});
