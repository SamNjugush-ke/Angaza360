// ===========================================================================
// Notification provider interface (Task T-A3).
//
// The standard every external integration follows (the engineering ledger "External
// Integrations"): ONE interface, implementations selected by CONFIG, and a single
// factory (./factory.ts) that is the only place a concrete class is named. Nothing
// else — the notification service, the password-recovery flow, staff invitations —
// knows which provider is behind it.
//
// SMS IS FIRST-CLASS. Most Kenyan MSME staff are reached by phone before email, so
// SMS is not a fallback channel bolted onto email: both are peers here.
//
// A provider NEVER logs the body or a credential. A body can carry a raw
// single-use token, and the raw token exists nowhere but in the recipient's inbox.
// ===========================================================================

/** The normalized result every provider returns, whichever API is behind it. */
export interface SendResult {
  /** The provider's id for the message, when it gives one. */
  readonly providerMessageId: string | null;
  /** Whether the provider ACCEPTED the message for delivery. */
  readonly accepted: boolean;
}

export interface SmsProvider {
  readonly name: string;
  sendSms(to: string, body: string): Promise<SendResult>;
}

export interface EmailProvider {
  readonly name: string;
  sendEmail(to: string, subject: string, body: string): Promise<SendResult>;
}

/** A provider that speaks both channels — the simulator does. */
export interface NotificationProvider extends SmsProvider, EmailProvider {}

/**
 * The provider refused the message or could not be reached. Its message is safe to
 * store on the delivery record: an implementation builds it from the HTTP status and
 * the provider's own status words — never from the body or a credential.
 */
export class NotificationDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotificationDeliveryError";
  }
}
