// ===========================================================================
// THE NOTIFICATION FACTORY + LIVE PROVIDERS (Task T-A3) — unit level, no network.
//
// * Default config selects the SIMULATOR for both channels.
// * Selecting a live provider resolves its credentials from the PLATFORM credential
//   store (stubbed here) and NEVER reads a secret from the environment — every
//   process.env read during resolution is recorded and checked.
// * Each live provider's request shape is verified with fetch stubbed, and its
//   failures carry neither the credential nor the body.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SMS_KEY = "at-test-key-0123456789-SECRET";
const MAIL_KEY = "SG.test-key-0123456789-SECRET";

const store = vi.hoisted(() => ({
  africasTalking: vi.fn(),
  sendgrid: vi.fn(),
}));

const config = vi.hoisted(() => ({
  smsProvider: "simulated" as "simulated" | "africastalking",
  emailProvider: "simulated" as "simulated" | "sendgrid",
}));

vi.mock("../../src/services/credentials/credential-store", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/services/credentials/credential-store")>();
  return {
    ...original,
    getActiveAfricasTalkingCredentialFields: store.africasTalking,
    getActiveSendgridCredentialFields: store.sendgrid,
  };
});

vi.mock("../../src/config/env", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/config/env")>();
  // env is frozen, so the mock is a copy whose `notifications` reads the switch above.
  return {
    env: {
      ...original.env,
      get notifications() {
        return { smsProvider: config.smsProvider, emailProvider: config.emailProvider };
      },
    },
  };
});

import { getEmailProvider, getSmsProvider } from "../../src/services/notifications/factory";
import { AfricasTalkingSmsProvider } from "../../src/services/notifications/africastalking-provider";
import { SendgridEmailProvider } from "../../src/services/notifications/sendgrid-provider";
import { SimulatedNotificationProvider } from "../../src/services/notifications/simulated-provider";
import { NotificationDeliveryError } from "../../src/services/notifications/provider";

/** Runs `block` with process.env replaced by a recorder; returns every key read. */
async function envReadsDuring(block: () => Promise<unknown>): Promise<string[]> {
  const reads: string[] = [];
  const realEnv = process.env;
  process.env = new Proxy(realEnv, {
    get(target, property, receiver) {
      if (typeof property === "string") reads.push(property);
      return Reflect.get(target, property, receiver);
    },
  });
  try {
    await block();
  } finally {
    process.env = realEnv;
  }
  return reads;
}

const SECRETISH = /KEY|SECRET|TOKEN|PASS|USERNAME|SENDER|AFRICAS|SENDGRID|SMTP|API/i;

beforeEach(() => {
  config.smsProvider = "simulated";
  config.emailProvider = "simulated";
  store.africasTalking.mockReset().mockResolvedValue({ username: "angaza", apiKey: SMS_KEY, senderId: "ANGAZA" });
  store.sendgrid.mockReset().mockResolvedValue({ apiKey: MAIL_KEY, fromEmail: "no-reply@angaza360.test", fromName: "Angaza360" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("factory selection", () => {
  it("defaults to the simulator for both channels and touches no credential", async () => {
    expect(await getSmsProvider()).toBeInstanceOf(SimulatedNotificationProvider);
    expect(await getEmailProvider()).toBeInstanceOf(SimulatedNotificationProvider);
    expect(store.africasTalking).not.toHaveBeenCalled();
    expect(store.sendgrid).not.toHaveBeenCalled();
  });

  it("africastalking: credentials come from the PLATFORM store, and no secret is read from env", async () => {
    config.smsProvider = "africastalking";
    let provider: unknown;
    const reads = await envReadsDuring(async () => {
      provider = await getSmsProvider();
    });
    expect(provider).toBeInstanceOf(AfricasTalkingSmsProvider);
    expect(store.africasTalking).toHaveBeenCalledTimes(1);
    expect(reads.filter((key) => SECRETISH.test(key))).toEqual([]);
  });

  it("sendgrid: credentials come from the PLATFORM store, and no secret is read from env", async () => {
    config.emailProvider = "sendgrid";
    let provider: unknown;
    const reads = await envReadsDuring(async () => {
      provider = await getEmailProvider();
    });
    expect(provider).toBeInstanceOf(SendgridEmailProvider);
    expect(store.sendgrid).toHaveBeenCalledTimes(1);
    expect(reads.filter((key) => SECRETISH.test(key))).toEqual([]);
  });

  it("a live provider with no ACTIVE platform credential fails — it never falls back to the simulator", async () => {
    config.smsProvider = "africastalking";
    store.africasTalking.mockRejectedValueOnce(new Error("no active credential"));
    await expect(getSmsProvider()).rejects.toThrow("no active credential");
  });
});

describe("Africa's Talking request shape (fetch stubbed)", () => {
  it("posts the documented form with the stored apiKey as a header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ SMSMessageData: { Recipients: [{ statusCode: 101, status: "Success", messageId: "ATXid_1" }] } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    config.smsProvider = "africastalking";
    const provider = await getSmsProvider();
    const result = await provider.sendSms("+254712345678", "code 123");
    expect(result).toEqual({ providerMessageId: "ATXid_1", accepted: true });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.africastalking.com/version1/messaging");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ apiKey: SMS_KEY, Accept: "application/json" });
    const form = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(form)).toEqual({ username: "angaza", to: "+254712345678", message: "code 123", from: "ANGAZA" });
  });

  it("the sandbox username talks to the sandbox host (AT's own convention)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ SMSMessageData: { Recipients: [{ statusCode: 101, status: "Success", messageId: "x" }] } })),
    );
    vi.stubGlobal("fetch", fetchMock);
    await new AfricasTalkingSmsProvider({ username: "sandbox", apiKey: SMS_KEY }).sendSms("+254700000000", "hi");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.sandbox.africastalking.com/version1/messaging");
  });

  it("a refusal is a NotificationDeliveryError carrying neither the key nor the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ SMSMessageData: { Recipients: [{ statusCode: 403, status: "InvalidPhoneNumber", messageId: "None" }] } })),
      ),
    );
    const error = await new AfricasTalkingSmsProvider({ username: "angaza", apiKey: SMS_KEY })
      .sendSms("+254", "secret-body-123")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotificationDeliveryError);
    expect(String(error)).toContain("InvalidPhoneNumber");
    expect(String(error)).not.toContain(SMS_KEY);
    expect(String(error)).not.toContain("secret-body-123");
  });
});

describe("SendGrid request shape (fetch stubbed)", () => {
  it("posts v3 mail/send with a bearer key and reads X-Message-Id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202, headers: { "x-message-id": "sg-123" } }));
    vi.stubGlobal("fetch", fetchMock);
    config.emailProvider = "sendgrid";
    const provider = await getEmailProvider();
    const result = await provider.sendEmail("staff@example.test", "Subject", "Body text");
    expect(result).toEqual({ providerMessageId: "sg-123", accepted: true });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${MAIL_KEY}` });
    expect(JSON.parse(String(init.body))).toEqual({
      personalizations: [{ to: [{ email: "staff@example.test" }] }],
      from: { email: "no-reply@angaza360.test", name: "Angaza360" },
      subject: "Subject",
      content: [{ type: "text/plain", value: "Body text" }],
    });
  });

  it("a non-202 is a NotificationDeliveryError carrying neither the key nor the body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));
    const error = await new SendgridEmailProvider({ apiKey: MAIL_KEY, fromEmail: "a@b.test" })
      .sendEmail("x@y.test", "s", "secret-body-456")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotificationDeliveryError);
    expect(String(error)).toContain("401");
    expect(String(error)).not.toContain(MAIL_KEY);
    expect(String(error)).not.toContain("secret-body-456");
  });
});
