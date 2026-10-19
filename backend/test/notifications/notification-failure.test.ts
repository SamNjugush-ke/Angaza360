// ===========================================================================
// A FAILED DELIVERY IS A RECORDED OUTCOME (Task T-A3).
//
// With the factory stubbed to return a provider that refuses (or one whose platform
// credential is missing), sendNotification does not throw: it records the row FAILED
// with the reason in words — and that reason carries neither the body nor a secret.
// An UNEXPECTED error is recorded FAILED and then rethrown (a defect, not an outcome).
// ===========================================================================

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

const behaviour = vi.hoisted(() => ({ mode: "refuse" as "refuse" | "no-credential" | "bug" }));

vi.mock("../../src/services/notifications/factory", async () => {
  const { NotificationDeliveryError } = await import("../../src/services/notifications/provider");
  const { NoActivePlatformCredentialError } = await import("../../src/services/credentials/credential-store");
  const failing = async (): Promise<never> => {
    if (behaviour.mode === "refuse") throw new NotificationDeliveryError("Africa's Talking refused the SMS with HTTP 401.");
    if (behaviour.mode === "no-credential") throw new NoActivePlatformCredentialError("AFRICASTALKING", "sandbox");
    throw new TypeError("a programming error carrying secret-body-789");
  };
  return {
    getSmsProvider: async () => ({ name: "africastalking", sendSms: failing }),
    getEmailProvider: async () => ({ name: "sendgrid", sendEmail: failing }),
  };
});

import { platformDb } from "../../src/db/platform";
import { sendNotification } from "../../src/services/notifications/notification-service";

const createdLogIds: string[] = [];

afterAll(async () => {
  await platformDb.notificationLog.deleteMany({ where: { id: { in: createdLogIds } } });
});

function request(token: string) {
  return {
    channel: "SMS" as const,
    to: "+254700000003",
    template: { key: "password-reset" as const, fullName: "QA", token, expiresInMinutes: 60 },
  };
}

describe("failed deliveries", () => {
  it("a provider refusal is recorded FAILED with the reason, and does not throw", async () => {
    behaviour.mode = "refuse";
    const token = `tok-${randomUUID()}`;
    const outcome = await sendNotification(request(token));
    createdLogIds.push(outcome.notificationLogId);
    expect(outcome.status).toBe("FAILED");
    const row = await platformDb.notificationLog.findUniqueOrThrow({ where: { id: outcome.notificationLogId } });
    expect(row).toMatchObject({ status: "FAILED", sentAt: null });
    expect(row.error).toContain("HTTP 401");
    expect(row.error).not.toContain(token);
  });

  it("a missing platform credential is recorded FAILED — never silently simulated", async () => {
    behaviour.mode = "no-credential";
    const outcome = await sendNotification(request(`tok-${randomUUID()}`));
    createdLogIds.push(outcome.notificationLogId);
    const row = await platformDb.notificationLog.findUniqueOrThrow({ where: { id: outcome.notificationLogId } });
    expect(row.status).toBe("FAILED");
    expect(row.error).toMatch(/no ACTIVE AFRICASTALKING credential/);
  });

  it("an unexpected error is recorded FAILED without its message, then rethrown", async () => {
    behaviour.mode = "bug";
    await expect(sendNotification(request(`tok-${randomUUID()}`))).rejects.toThrow(TypeError);
    const row = await platformDb.notificationLog.findFirstOrThrow({
      where: { recipient: "+254700000003", error: { startsWith: "Unexpected" } },
      orderBy: { createdAt: "desc" },
    });
    createdLogIds.push(row.id);
    expect(row.status).toBe("FAILED");
    expect(row.error).toBe("Unexpected TypeError while sending.");
  });
});
