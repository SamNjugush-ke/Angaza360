// ===========================================================================
// Live email provider: authenticated SMTP through nodemailer (M4.5 Wave 4).
//
// The MVP's email channel. Behind the same EmailProvider interface as SendGrid and the simulator:
// selected by NOTIFICATION_EMAIL_PROVIDER=smtp, constructed PER SEND by the factory (the only
// place it is named) from Angaza's ACTIVE platform SMTP credential — decrypted by the credential
// store, never read from env, never logged.
//
// Written for real against nodemailer's SMTP transport; verified with the transport stubbed
// (request shape, TLS choice, error mapping, no secret in any message) and NOT network-tested
// here, like the other live providers.
//
// SECRECY: a delivery error is built from nodemailer's error CODE and the server's SMTP response
// CODE only — never the error's message (a server may echo the envelope or the AUTH exchange),
// never the body, never the password. The transport's own logger and debug output are OFF.
// ===========================================================================

import nodemailer from "nodemailer";
import type { SmtpCredentialFields } from "../credentials/provider-schemas";
import { NotificationDeliveryError, type EmailProvider, type SendResult } from "./provider";

const TIMEOUT_MS = 15_000;

/** The transport factory, swappable in tests. */
export type SmtpTransportFactory = typeof nodemailer.createTransport;

export class SmtpEmailProvider implements EmailProvider {
  readonly name = "smtp";
  private readonly credentials: SmtpCredentialFields;
  private readonly createTransport: SmtpTransportFactory;

  constructor(credentials: SmtpCredentialFields, createTransport: SmtpTransportFactory = nodemailer.createTransport) {
    this.credentials = credentials;
    this.createTransport = createTransport;
  }

  async sendEmail(to: string, subject: string, body: string): Promise<SendResult> {
    const c = this.credentials;
    const transport = this.createTransport(smtpTransportOptions(c));
    try {
      const info = await transport.sendMail({
        from: c.fromName === undefined ? c.fromEmail : { name: c.fromName, address: c.fromEmail },
        to,
        subject,
        text: body,
      });
      const accepted = Array.isArray(info.accepted) && info.accepted.length > 0;
      if (!accepted) throw new NotificationDeliveryError("The SMTP server did not accept the recipient.");
      return { providerMessageId: typeof info.messageId === "string" ? info.messageId : null, accepted: true };
    } catch (error) {
      if (error instanceof NotificationDeliveryError) throw error;
      throw new NotificationDeliveryError(describe(error));
    } finally {
      transport.close();
    }
  }
}

/** The ONE set of transport options — sending and verifying use exactly the same settings. */
export function smtpTransportOptions(c: SmtpCredentialFields) {
  return {
    host: c.host,
    port: c.port,
    secure: c.secure,
    // STARTTLS is required, not opportunistic, on a non-implicit-TLS port: credentials never
    // cross the wire in the clear.
    requireTLS: !c.secure,
    auth: { user: c.username, pass: c.password },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
    logger: false,
    debug: false,
    // A message is ours only: no file or URL content may be pulled in.
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

/**
 * Verifies an SMTP credential (M4.5 W5): connects, negotiates TLS and logs in — sending nothing.
 * The outcome's detail is built like a send failure's: codes only, never the server's words.
 */
export async function verifySmtpCredentials(c: SmtpCredentialFields, createTransport: SmtpTransportFactory = nodemailer.createTransport): Promise<{ ok: boolean; detail: string }> {
  const transport = createTransport(smtpTransportOptions(c));
  try {
    await transport.verify();
    return { ok: true, detail: "Connected and signed in to the SMTP server." };
  } catch (error) {
    return { ok: false, detail: describe(error) };
  } finally {
    transport.close();
  }
}

/** A safe description of a failure: the error code and the SMTP response code, nothing else. */
function describe(error: unknown): string {
  const record = typeof error === "object" && error !== null ? (error as { code?: unknown; responseCode?: unknown }) : {};
  const code = typeof record.code === "string" && /^[A-Z_]{2,40}$/.test(record.code) ? record.code : null;
  const response = typeof record.responseCode === "number" ? record.responseCode : null;
  if (code === "EAUTH") return `The SMTP server refused the login${response !== null ? ` (SMTP ${response.toString()})` : ""}.`;
  if (code === "ECONNECTION" || code === "ETIMEDOUT" || code === "ESOCKET" || code === "EDNS") {
    return `The SMTP server could not be reached (${code}).`;
  }
  if (response !== null) return `The SMTP server refused the email (SMTP ${response.toString()}).`;
  return `The email could not be sent through SMTP${code !== null ? ` (${code})` : ""}.`;
}
