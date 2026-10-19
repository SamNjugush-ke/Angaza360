// ===========================================================================
// Live email provider: SendGrid v3 Mail Send over HTTPS (Task T-A3).
//
// Written for real against SendGrid's documented `POST /v3/mail/send` using the
// built-in fetch — no vendor SDK, no SMTP client. A CONFIG SEAM like the real
// Daraja provider: selected by NOTIFICATION_EMAIL_PROVIDER=sendgrid, verified by unit
// tests of its request shape and response handling with fetch stubbed, and NOT
// network-tested here.
//
// Its credentials (apiKey, fromEmail, fromName) are Angaza's PLATFORM credentials,
// handed in by the factory from the encrypted platform store. Never env, never
// logged: errors carry the HTTP status only.
// ===========================================================================

import type { SendgridCredentialFields } from "../credentials/provider-schemas";
import { NotificationDeliveryError, type EmailProvider, type SendResult } from "./provider";

const REQUEST_TIMEOUT_MS = 10_000;
export const SENDGRID_MAIL_SEND_URL = "https://api.sendgrid.com/v3/mail/send";

export class SendgridEmailProvider implements EmailProvider {
  readonly name = "sendgrid";
  private readonly credentials: SendgridCredentialFields;

  constructor(credentials: SendgridCredentialFields) {
    this.credentials = credentials;
  }

  async sendEmail(to: string, subject: string, body: string): Promise<SendResult> {
    const from =
      this.credentials.fromName === undefined
        ? { email: this.credentials.fromEmail }
        : { email: this.credentials.fromEmail, name: this.credentials.fromName };

    let response: Response;
    try {
      response = await fetch(SENDGRID_MAIL_SEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.credentials.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from,
          subject,
          content: [{ type: "text/plain", value: body }],
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : "unknown error";
      throw new NotificationDeliveryError(`SendGrid could not be reached (${reason}).`);
    }

    // SendGrid answers 202 Accepted with an empty body and the id in X-Message-Id.
    if (response.status !== 202) {
      throw new NotificationDeliveryError(`SendGrid refused the email with HTTP ${response.status.toString()}.`);
    }
    return { providerMessageId: response.headers.get("x-message-id"), accepted: true };
  }
}
