// ===========================================================================
// Notification service (Task T-A3) — the send API the rest of the app calls.
//
// It renders a template, records the send in `notification_logs` (the ONLY writer
// of that table), hands the message to the channel's provider (resolved per send by
// ./factory.ts) and records how it ended:
//
//   QUEUED  -> SIMULATED   the simulator took it (nothing left the server)
//           -> SENT        a live provider accepted it
//           -> FAILED      a live provider refused it, could not be reached, or has
//                          no ACTIVE platform credential — with the reason in words
//
// THE BODY IS NEVER STORED AND NEVER LOGGED. A password-reset body carries the raw
// reset code and an invitation body the raw invite token; those exist server-side
// only as hashes. The log row records recipient, template, provider and outcome.
//
// A PROVIDER FAILURE DOES NOT THROW: it is a recorded outcome the caller can act on
// (and, for an enumeration-safe flow, must NOT reveal). An UNEXPECTED error is
// recorded as FAILED too and then rethrown — it is a defect, not an outcome.
// ===========================================================================

import { platformDb } from "../../db/platform";
import { env } from "../../config/env";
import { PRODUCT_NAME } from "../../config/brand";
import type { NotificationChannel, NotificationStatus } from "../../generated/platform/enums";
import { NoActivePlatformCredentialError } from "../credentials/credential-store";
import { getEmailProvider, getSmsProvider } from "./factory";
import { NotificationDeliveryError, type SendResult } from "./provider";
import { SIMULATED_PROVIDER_NAME } from "./simulated-provider";

// ---- Templates -------------------------------------------------------------

export type NotificationTemplate =
  | {
      readonly key: "password-reset";
      readonly fullName: string;
      readonly token: string;
      readonly expiresInMinutes: number;
    }
  | {
      readonly key: "user-invitation";
      readonly token: string;
      readonly role: string;
      readonly businessName: string | null;
      readonly inviterName: string;
      readonly expiresInHours: number;
    };

export type NotificationTemplateKey = NotificationTemplate["key"];

export interface RenderedMessage {
  readonly subject: string;
  readonly body: string;
}


/** Renders a template for a channel. SMS bodies are kept to one short message. */
export function renderTemplate(channel: NotificationChannel, template: NotificationTemplate): RenderedMessage {
  switch (template.key) {
    case "password-reset": {
      const subject = `${PRODUCT_NAME} password reset`;
      const body =
        channel === "SMS"
          ? `${PRODUCT_NAME}: your password reset code is ${template.token}. It expires in ${template.expiresInMinutes.toString()} minutes. If you did not ask for it, ignore this message.`
          : `Hello ${template.fullName},\n\nSomeone asked to reset the password for your ${PRODUCT_NAME} account. Use this reset code:\n\n${template.token}\n\nIt can be used once and expires in ${template.expiresInMinutes.toString()} minutes. If you did not ask for a reset, ignore this email; your password has not changed.`;
      return { subject, body };
    }
    case "user-invitation": {
      const where = template.businessName === null ? PRODUCT_NAME : `${template.businessName} on ${PRODUCT_NAME}`;
      const subject = `You have been invited to ${where}`;
      const body =
        channel === "SMS"
          ? `${template.inviterName} invited you to ${where} as ${template.role}. Your invitation code is ${template.token}. It expires in ${template.expiresInHours.toString()} hours.`
          : `Hello,\n\n${template.inviterName} has invited you to join ${where} as ${template.role}.\n\nYour invitation code:\n\n${template.token}\n\nIt can be used once and expires in ${template.expiresInHours.toString()} hours.`;
      return { subject, body };
    }
    default: {
      const exhaustive: never = template;
      throw new Error(`Unknown notification template ${JSON.stringify(exhaustive)}.`);
    }
  }
}

// ---- Sending ---------------------------------------------------------------

export interface NotificationRequest {
  readonly channel: NotificationChannel;
  readonly to: string;
  readonly template: NotificationTemplate;
  /** What the message is about, e.g. { type: "PasswordResetToken", id }. */
  readonly related?: { readonly type: string; readonly id: string };
}

export interface NotificationOutcome {
  readonly notificationLogId: string;
  readonly status: NotificationStatus;
  readonly providerName: string;
}

function configuredProviderName(channel: NotificationChannel): string {
  return channel === "SMS" ? env.notifications.smsProvider : env.notifications.emailProvider;
}

async function deliver(request: NotificationRequest, rendered: RenderedMessage): Promise<SendResult & { providerName: string }> {
  if (request.channel === "SMS") {
    const provider = await getSmsProvider();
    return { ...(await provider.sendSms(request.to, rendered.body)), providerName: provider.name };
  }
  const provider = await getEmailProvider();
  return { ...(await provider.sendEmail(request.to, rendered.subject, rendered.body)), providerName: provider.name };
}

export async function sendNotification(request: NotificationRequest): Promise<NotificationOutcome> {
  const rendered = renderTemplate(request.channel, request.template);
  const providerName = configuredProviderName(request.channel);

  const log = await platformDb.notificationLog.create({
    data: {
      channel: request.channel,
      recipient: request.to,
      templateKey: request.template.key,
      relatedType: request.related?.type ?? null,
      relatedId: request.related?.id ?? null,
      providerName,
    },
    select: { id: true },
  });

  const fail = async (reason: string): Promise<NotificationOutcome> => {
    await platformDb.notificationLog.update({
      where: { id: log.id },
      data: { status: "FAILED", error: reason },
    });
    return { notificationLogId: log.id, status: "FAILED", providerName };
  };

  let result: SendResult & { providerName: string };
  try {
    result = await deliver(request, rendered);
  } catch (error) {
    if (error instanceof NotificationDeliveryError || error instanceof NoActivePlatformCredentialError) {
      return fail(error.message);
    }
    // A defect, not a delivery outcome: record it without its message (which nothing
    // has vetted for secrets), then let it surface.
    await fail(`Unexpected ${error instanceof Error ? error.name : "error"} while sending.`);
    throw error;
  }

  if (!result.accepted) {
    return fail(`${result.providerName} did not accept the message.`);
  }
  const status: NotificationStatus = result.providerName === SIMULATED_PROVIDER_NAME ? "SIMULATED" : "SENT";
  await platformDb.notificationLog.update({
    where: { id: log.id },
    data: { status, providerMessageId: result.providerMessageId, sentAt: new Date() },
  });
  return { notificationLogId: log.id, status, providerName };
}
