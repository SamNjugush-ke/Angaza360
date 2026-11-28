// ===========================================================================
// THE SMTP EMAIL PROVIDER (M4.5 W4) — no network: nodemailer's transport is replaced by a
// recorder. Proven: the request shape (TLS required, credentials only in `auth`, no file/URL
// access, no transport logging), the implicit-TLS choice on 465, every failure mapped to a
// NotificationDeliveryError that carries neither the password nor the body nor the server's
// words, nothing written to any log, the credential stored encrypted and validated before it is
// stored, and the From header parsed from SMTP_FROM.
// ===========================================================================

import { afterAll, describe, expect, it, vi } from "vitest";
import type { SmtpTransportFactory } from "../../src/services/notifications/smtp-provider";
import { SmtpEmailProvider } from "../../src/services/notifications/smtp-provider";
import { NotificationDeliveryError } from "../../src/services/notifications/provider";
import { parseSmtpCredentialFields } from "../../src/services/credentials/provider-schemas";
import {
  getActiveSmtpCredentialFields,
  NoActivePlatformCredentialError,
  putActivePlatformCredential,
} from "../../src/services/credentials/credential-store";
import { platformDb } from "../../src/db/platform";
import { pool } from "../../src/db/pool";
import { splitFrom } from "../../src/scripts/seed-platform-credentials";
import { captureOutput } from "../support/log-capture";

const PASSWORD = "smtp-pass-0123456789-SECRET";
const BODY = "Your reset code is 918273 — it expires in 60 minutes.";
const CREDS = parseSmtpCredentialFields({ host: "smtp.mail.test", port: "587", username: "no-reply@angaza360.test", password: PASSWORD, fromEmail: "no-reply@angaza360.test", fromName: "Angaza360" });

interface Recorded {
  options: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
  closed: number;
}

function fakeTransport(outcome: (message: Record<string, unknown>) => Promise<unknown>): { factory: SmtpTransportFactory; recorded: Recorded } {
  const recorded: Recorded = { options: {}, messages: [], closed: 0 };
  const factory = ((options: Record<string, unknown>) => {
    recorded.options = options;
    return {
      sendMail: async (message: Record<string, unknown>) => {
        recorded.messages.push(message);
        return outcome(message);
      },
      close: () => {
        recorded.closed += 1;
      },
    };
  }) as unknown as SmtpTransportFactory;
  return { factory, recorded };
}

const accepted = async (message: Record<string, unknown>) => ({ accepted: [message.to], rejected: [], messageId: "<abc@mail.test>" });

describe("SmtpEmailProvider", () => {
  it("sends one authenticated, TLS-required message with the body as plain text", async () => {
    const { factory, recorded } = fakeTransport(accepted);
    const result = await new SmtpEmailProvider(CREDS, factory).sendEmail("owner@shop.test", "Reset your password", BODY);
    expect(result).toEqual({ providerMessageId: "<abc@mail.test>", accepted: true });
    expect(recorded.options).toMatchObject({
      host: "smtp.mail.test",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: "no-reply@angaza360.test", pass: PASSWORD },
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    expect(recorded.messages).toEqual([{ from: { name: "Angaza360", address: "no-reply@angaza360.test" }, to: "owner@shop.test", subject: "Reset your password", text: BODY }]);
    expect(recorded.closed).toBe(1);
  });

  it("port 465 means implicit TLS unless stated otherwise", () => {
    expect(parseSmtpCredentialFields({ host: "h", port: "465", username: "u", password: "p", fromEmail: "a@b.test" }).secure).toBe(true);
    expect(parseSmtpCredentialFields({ host: "h", port: "587", username: "u", password: "p", fromEmail: "a@b.test" }).secure).toBe(false);
    expect(parseSmtpCredentialFields({ host: "h", port: "2525", secure: "true", username: "u", password: "p", fromEmail: "a@b.test" }).secure).toBe(true);
  });

  it("refuses an unusable credential: a bad port, a bad secure flag, a missing password, a bad sender", () => {
    const base = { host: "h", port: "587", username: "u", password: "p", fromEmail: "a@b.test" };
    expect(() => parseSmtpCredentialFields({ ...base, port: "0" })).toThrow(/port/);
    expect(() => parseSmtpCredentialFields({ ...base, port: "abc" })).toThrow(/port/);
    expect(() => parseSmtpCredentialFields({ ...base, secure: "yes" })).toThrow(/secure/);
    expect(() => parseSmtpCredentialFields({ ...base, password: "" })).toThrow(/password/);
    expect(() => parseSmtpCredentialFields({ ...base, fromEmail: "not-an-address" })).toThrow(/fromEmail/);
  });

  it("maps every failure to a NotificationDeliveryError with no secret, no body and no server words — and logs nothing", async () => {
    const failures: Array<[unknown, RegExp]> = [
      [Object.assign(new Error(`Invalid login: 535 5.7.8 Username and Password not accepted for ${PASSWORD}`), { code: "EAUTH", responseCode: 535 }), /refused the login \(SMTP 535\)/],
      [Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:587"), { code: "ECONNECTION" }), /could not be reached \(ECONNECTION\)/],
      [Object.assign(new Error(`550 Rejected: ${BODY}`), { code: "EENVELOPE", responseCode: 550 }), /refused the email \(SMTP 550\)/],
      [new Error(`something odd ${PASSWORD}`), /could not be sent through SMTP/],
    ];
    const { output } = await captureOutput(async () => {
      for (const [error, expected] of failures) {
        const { factory, recorded } = fakeTransport(async () => {
          throw error;
        });
        const failure = await new SmtpEmailProvider(CREDS, factory).sendEmail("owner@shop.test", "Reset", BODY).catch((e: unknown) => e);
        expect(failure).toBeInstanceOf(NotificationDeliveryError);
        const message = (failure as Error).message;
        expect(message).toMatch(expected);
        for (const secret of [PASSWORD, BODY, "Username and Password", "ECONNREFUSED 10.0.0.1"]) expect(message).not.toContain(secret);
        expect(recorded.closed).toBe(1);
      }
      // A recipient the server did not accept is a failure too, never a silent "sent".
      const { factory } = fakeTransport(async () => ({ accepted: [], rejected: ["owner@shop.test"], messageId: "<x@y>" }));
      await expect(new SmtpEmailProvider(CREDS, factory).sendEmail("owner@shop.test", "Reset", BODY)).rejects.toBeInstanceOf(NotificationDeliveryError);
    });
    expect(output).not.toContain(PASSWORD);
    expect(output).not.toContain(BODY);
  });
});

describe("the SMTP platform credential", () => {
  afterAll(async () => {
    await platformDb.platformIntegrationCredential.deleteMany({ where: { provider: "SMTP" } });
  });

  it("is validated before it is stored, kept as ciphertext, and decrypted only while ACTIVE", async () => {
    await platformDb.platformIntegrationCredential.deleteMany({ where: { provider: "SMTP" } });
    await expect(getActiveSmtpCredentialFields()).rejects.toBeInstanceOf(NoActivePlatformCredentialError);
    // An unusable credential is never stored.
    await expect(putActivePlatformCredential("SMTP", "sandbox", { host: "h", port: "99999", username: "u", password: PASSWORD, fromEmail: "a@b.test" }, "test")).rejects.toThrow(/port/);
    expect(await platformDb.platformIntegrationCredential.count({ where: { provider: "SMTP" } })).toBe(0);

    const view = await putActivePlatformCredential("SMTP", "sandbox", { host: "smtp.mail.test", port: "587", username: "u", password: PASSWORD, fromEmail: "a@b.test" }, "test");
    expect(view).toMatchObject({ provider: "SMTP", environment: "sandbox", status: "ACTIVE", keyRef: "app-v1" });
    expect(JSON.stringify(view)).not.toContain(PASSWORD);
    const raw = await pool.query(`SELECT * FROM public.platform_integration_credentials WHERE "provider" = 'SMTP'`);
    expect(JSON.stringify(raw.rows)).not.toContain(PASSWORD);
    expect(await getActiveSmtpCredentialFields()).toEqual({ host: "smtp.mail.test", port: 587, secure: false, username: "u", password: PASSWORD, fromEmail: "a@b.test" });

    await platformDb.platformIntegrationCredential.updateMany({ where: { provider: "SMTP" }, data: { status: "PENDING" } });
    await expect(getActiveSmtpCredentialFields()).rejects.toBeInstanceOf(NoActivePlatformCredentialError);
  });

  it("the seeder reads SMTP_FROM as a display name and an address, or a bare address", () => {
    expect(splitFrom("Angaza360 <hello@angaza360.co.ke>")).toEqual({ fromEmail: "hello@angaza360.co.ke", fromName: "Angaza360" });
    expect(splitFrom('"Angaza 360" <hello@angaza360.co.ke>')).toEqual({ fromEmail: "hello@angaza360.co.ke", fromName: "Angaza 360" });
    expect(splitFrom("hello@angaza360.co.ke")).toEqual({ fromEmail: "hello@angaza360.co.ke" });
  });
});

vi.setConfig({ testTimeout: 30_000 });
