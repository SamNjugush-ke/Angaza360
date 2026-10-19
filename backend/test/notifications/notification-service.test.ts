// ===========================================================================
// THE NOTIFICATION SERVICE (Task T-A3) against the test database.
//
// * A simulated send writes a notification_logs row — SIMULATED, sentAt stamped,
//   recipient, template and related document recorded — and the simulator's outbox
//   holds the RENDERED body.
// * The body (which can carry a raw single-use token) is stored NOWHERE in the
//   database and printed NOWHERE in any log line.
// * The delivery record's guarantees hold against raw SQL (born QUEUED, one terminal
//   transition, frozen identity, coherent resting state) — with a control.
// * The platform credential store decrypts only an ACTIVE row of the deployment's
//   environment (sandbox here), and only through its typed doors.
// ===========================================================================

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool";
import { platformDb } from "../../src/db/platform";
import { encryptCredential, serialiseCredentialFields } from "../../src/lib/crypto/credential-cipher";
import {
  getActiveAfricasTalkingCredentialFields,
  getActiveSendgridCredentialFields,
  NoActivePlatformCredentialError,
  platformCredentialEnvironment,
} from "../../src/services/credentials/credential-store";
import { renderTemplate, sendNotification } from "../../src/services/notifications/notification-service";
import { simulatedOutbox } from "../../src/services/notifications/simulated-provider";
import { expectDbRefusal } from "../support/db-errors";
import { captureOutput } from "../support/log-capture";
import { withPlatformTx } from "../support/platform-tx";

const createdLogIds: string[] = [];

afterAll(async () => {
  // notification_logs is mutable (not append-only); test rows are removed.
  await platformDb.notificationLog.deleteMany({ where: { id: { in: createdLogIds } } });
  await platformDb.platformIntegrationCredential.deleteMany({
    where: { provider: { in: ["AFRICASTALKING", "SENDGRID"] }, environment: "sandbox" },
  });
});

describe("a simulated send", () => {
  it("records SIMULATED with the rendered body in the outbox — and the body nowhere else", async () => {
    const token = `tok-${randomUUID()}`;
    const relatedId = randomUUID();
    const { result: outcome, output } = await captureOutput(() =>
      sendNotification({
        channel: "EMAIL",
        to: "qa-notify@test.invalid",
        template: { key: "password-reset", fullName: "QA Person", token, expiresInMinutes: 60 },
        related: { type: "PasswordResetToken", id: relatedId },
      }),
    );
    createdLogIds.push(outcome.notificationLogId);
    expect(outcome).toMatchObject({ status: "SIMULATED", providerName: "simulated" });

    const row = await platformDb.notificationLog.findUniqueOrThrow({ where: { id: outcome.notificationLogId } });
    expect(row).toMatchObject({
      channel: "EMAIL",
      recipient: "qa-notify@test.invalid",
      templateKey: "password-reset",
      relatedType: "PasswordResetToken",
      relatedId,
      status: "SIMULATED",
      providerName: "simulated",
      error: null,
    });
    expect(row.sentAt).toBeInstanceOf(Date);
    expect(row.providerMessageId).toMatch(/^sim-/);

    // The simulator holds exactly what renderTemplate produced, token included.
    const expected = renderTemplate("EMAIL", { key: "password-reset", fullName: "QA Person", token, expiresInMinutes: 60 });
    const delivered = simulatedOutbox().find((message) => message.providerMessageId === row.providerMessageId);
    expect(delivered).toMatchObject({ channel: "EMAIL", to: "qa-notify@test.invalid", subject: expected.subject, body: expected.body });
    expect(delivered?.body).toContain(token);

    // ...and nowhere else: not in the row, not in any column of the table, not in a log line.
    expect(JSON.stringify(row)).not.toContain(token);
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'notification_logs'`,
    );
    expect(columns.rows.map((column) => column.column_name)).not.toContain("body");
    expect(output).not.toContain(token);
  });

  it("SMS is first-class: an SMS send records channel SMS and a short rendered body", async () => {
    const token = `tok-${randomUUID()}`;
    const outcome = await sendNotification({
      channel: "SMS",
      to: "+254700000001",
      template: { key: "user-invitation", token, role: "CASHIER", businessName: "QA Shop", inviterName: "QA Owner", expiresInHours: 72 },
    });
    createdLogIds.push(outcome.notificationLogId);
    const row = await platformDb.notificationLog.findUniqueOrThrow({ where: { id: outcome.notificationLogId } });
    expect(row).toMatchObject({ channel: "SMS", recipient: "+254700000001", templateKey: "user-invitation", status: "SIMULATED" });
    const delivered = simulatedOutbox().find((message) => message.providerMessageId === row.providerMessageId);
    expect(delivered?.subject).toBeNull();
    expect(delivered?.body).toContain(token);
    expect((delivered?.body ?? "").length).toBeLessThanOrEqual(160);
  });
});

describe("the delivery record's database guarantees", () => {
  async function insertQueued(client: import("pg").PoolClient): Promise<string> {
    const id = randomUUID();
    await client.query(
      `INSERT INTO public.notification_logs ("id", "channel", "recipient", "templateKey", "providerName")
       VALUES ($1, 'SMS', '+254700000002', 'password-reset', 'simulated')`,
      [id],
    );
    return id;
  }

  it("control: QUEUED -> SENT with sentAt is accepted", async () => {
    await withPlatformTx(async (client) => {
      const id = await insertQueued(client);
      await client.query(`UPDATE public.notification_logs SET "status" = 'SENT', "sentAt" = now() WHERE "id" = $1`, [id]);
    });
  });

  it("a row cannot be born already SENT", async () => {
    await withPlatformTx(async (client) => {
      await expectDbRefusal(
        client.query(
          `INSERT INTO public.notification_logs ("id", "channel", "recipient", "templateKey", "providerName", "status", "sentAt")
           VALUES ($1, 'SMS', '+254', 'password-reset', 'simulated', 'SENT', now())`,
          [randomUUID()],
        ),
        { fn: "notification_log_guard", message: /QUEUED before it is sent/ },
      );
    });
  });

  it("an outcome is terminal: SENT cannot move again", async () => {
    await withPlatformTx(async (client) => {
      const id = await insertQueued(client);
      await client.query(`UPDATE public.notification_logs SET "status" = 'SENT', "sentAt" = now() WHERE "id" = $1`, [id]);
      await expectDbRefusal(
        client.query(`UPDATE public.notification_logs SET "status" = 'FAILED', "sentAt" = NULL, "error" = 'x' WHERE "id" = $1`, [id]),
        { fn: "notification_log_guard", message: /terminal/ },
      );
    });
  });

  it("what was sent and to whom is frozen", async () => {
    await withPlatformTx(async (client) => {
      const id = await insertQueued(client);
      await expectDbRefusal(
        client.query(`UPDATE public.notification_logs SET "recipient" = '+254799999999' WHERE "id" = $1`, [id]),
        { fn: "notification_log_guard", message: /can never change/ },
      );
    });
  });

  it("the resting state is coherent: SENT without sentAt is refused by the CHECK", async () => {
    await withPlatformTx(async (client) => {
      const id = await insertQueued(client);
      await expectDbRefusal(
        client.query(`UPDATE public.notification_logs SET "status" = 'SENT' WHERE "id" = $1`, [id]),
        { constraint: "notification_log_status_coherent", code: "23514" },
      );
    });
  });
});

describe("platform notification credentials (the store's typed doors)", () => {
  async function storePlatformCredential(provider: string, fields: Record<string, string>, status: string): Promise<void> {
    const encrypted = encryptCredential(serialiseCredentialFields(fields));
    await platformDb.platformIntegrationCredential.upsert({
      where: { provider_environment: { provider, environment: "sandbox" } },
      create: { provider, environment: "sandbox", ...encrypted, status },
      update: { ...encrypted, status },
    });
  }

  it("a non-production deployment reads the sandbox row", () => {
    expect(platformCredentialEnvironment()).toBe("sandbox");
  });

  it("decrypts only an ACTIVE row: PENDING is NoActivePlatformCredentialError, ACTIVE returns the typed fields", async () => {
    await storePlatformCredential("AFRICASTALKING", { username: "sandbox", apiKey: "k-123" }, "PENDING");
    await expect(getActiveAfricasTalkingCredentialFields()).rejects.toBeInstanceOf(NoActivePlatformCredentialError);

    await storePlatformCredential("AFRICASTALKING", { username: "sandbox", apiKey: "k-123", senderId: "ANGAZA" }, "ACTIVE");
    expect(await getActiveAfricasTalkingCredentialFields()).toEqual({ username: "sandbox", apiKey: "k-123", senderId: "ANGAZA" });

    await storePlatformCredential("SENDGRID", { apiKey: "SG.k", fromEmail: "no-reply@angaza360.test" }, "ACTIVE");
    expect(await getActiveSendgridCredentialFields()).toEqual({ apiKey: "SG.k", fromEmail: "no-reply@angaza360.test" });
  });

  it("the stored row holds ciphertext only — no plaintext field", async () => {
    await storePlatformCredential("SENDGRID", { apiKey: "SG.plaintext-must-not-appear", fromEmail: "a@b.test" }, "ACTIVE");
    const raw = await pool.query(`SELECT * FROM public.platform_integration_credentials WHERE "provider" = 'SENDGRID' AND "environment" = 'sandbox'`);
    expect(JSON.stringify(raw.rows)).not.toContain("SG.plaintext-must-not-appear");
  });
});
