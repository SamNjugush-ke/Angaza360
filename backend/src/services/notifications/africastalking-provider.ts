// ===========================================================================
// Live SMS provider: Africa's Talking (Task T-A3).
//
// Written for real against Africa's Talking's documented Messaging API using the
// built-in fetch — no vendor SDK. Like the real Daraja provider it is a CONFIG
// SEAM: it is selected by NOTIFICATION_SMS_PROVIDER=africastalking, it is verified
// by unit tests of its request shape and response handling with fetch stubbed, and
// it is NOT network-tested here (that needs Angaza's own AT account).
//
// Its credentials (username, apiKey, senderId) are Angaza's PLATFORM credentials,
// handed in by the factory from the encrypted platform store. Never env, never
// logged: errors are built from the HTTP status and AT's status words only.
//
// THE HOST IS DERIVED, per Africa's Talking's own convention: the username
// "sandbox" talks to the sandbox host; every other username to production.
// ===========================================================================

import type { AfricasTalkingCredentialFields } from "../credentials/provider-schemas";
import { NotificationDeliveryError, type SendResult, type SmsProvider } from "./provider";

const REQUEST_TIMEOUT_MS = 10_000;

// Africa's Talking per-recipient status codes that mean "accepted for delivery":
// 100 Processed, 101 Sent, 102 Queued.
const ACCEPTED_STATUS_CODES: ReadonlySet<number> = new Set([100, 101, 102]);

export function africasTalkingBaseUrl(username: string): string {
  return username === "sandbox"
    ? "https://api.sandbox.africastalking.com"
    : "https://api.africastalking.com";
}

interface AtRecipient {
  readonly statusCode?: unknown;
  readonly status?: unknown;
  readonly messageId?: unknown;
}

function firstRecipient(payload: unknown): AtRecipient | null {
  if (typeof payload !== "object" || payload === null || !("SMSMessageData" in payload)) {
    return null;
  }
  const data = payload.SMSMessageData;
  if (typeof data !== "object" || data === null || !("Recipients" in data) || !Array.isArray(data.Recipients)) {
    return null;
  }
  const recipient: unknown = data.Recipients[0];
  return typeof recipient === "object" && recipient !== null ? (recipient as AtRecipient) : null;
}

export class AfricasTalkingSmsProvider implements SmsProvider {
  readonly name = "africastalking";
  private readonly credentials: AfricasTalkingCredentialFields;

  constructor(credentials: AfricasTalkingCredentialFields) {
    this.credentials = credentials;
  }

  async sendSms(to: string, body: string): Promise<SendResult> {
    const form = new URLSearchParams({ username: this.credentials.username, to, message: body });
    if (this.credentials.senderId !== undefined) {
      form.set("from", this.credentials.senderId);
    }

    let response: Response;
    try {
      response = await fetch(`${africasTalkingBaseUrl(this.credentials.username)}/version1/messaging`, {
        method: "POST",
        headers: {
          apiKey: this.credentials.apiKey,
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : "unknown error";
      throw new NotificationDeliveryError(`Africa's Talking could not be reached (${reason}).`);
    }

    if (!response.ok) {
      throw new NotificationDeliveryError(`Africa's Talking refused the SMS with HTTP ${response.status.toString()}.`);
    }

    const recipient = firstRecipient(await response.json());
    if (recipient === null) {
      throw new NotificationDeliveryError("Africa's Talking response carried no recipient status.");
    }
    const statusCode = typeof recipient.statusCode === "number" ? recipient.statusCode : null;
    const messageId = typeof recipient.messageId === "string" && recipient.messageId !== "None" ? recipient.messageId : null;
    if (statusCode === null || !ACCEPTED_STATUS_CODES.has(statusCode)) {
      const status = typeof recipient.status === "string" ? recipient.status : "unknown status";
      throw new NotificationDeliveryError(
        `Africa's Talking did not accept the SMS: ${status} (code ${statusCode === null ? "none" : statusCode.toString()}).`,
      );
    }
    return { providerMessageId: messageId, accepted: true };
  }
}
