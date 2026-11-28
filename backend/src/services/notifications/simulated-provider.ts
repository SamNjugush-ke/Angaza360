// ===========================================================================
// The SIMULATED notification provider (Task T-A3) — the default for both channels.
//
// It performs no network call. It RECORDS each message (channel, recipient,
// rendered subject and body) in an in-process outbox so tests — and a developer
// stepping through a flow — can read what would have been delivered. A body can carry a
// raw single-use token, so the outbox is memory only and never persisted, and the message is
// echoed to the console in DEVELOPMENT only (never production, never test — see record()). It
// is bounded, so a long-running dev server cannot grow it without limit.
// ===========================================================================

import { randomUUID } from "node:crypto";
import { env } from "../../config/env";
import type { NotificationProvider, SendResult } from "./provider";

export interface SimulatedMessage {
  readonly channel: "SMS" | "EMAIL";
  readonly to: string;
  readonly subject: string | null;
  readonly body: string;
  readonly providerMessageId: string;
  readonly at: Date;
}

const OUTBOX_LIMIT = 200;
const outbox: SimulatedMessage[] = [];

function record(message: SimulatedMessage): SendResult {
  outbox.push(message);
  // DEVELOPMENT ONLY (Task T-B-INVITE-LINK): echo the whole message to the dev server's console, so
  // an invitation or a reset can be followed locally — the simulator delivers nowhere else. Never in
  // production (the flag cannot be on there), off in test, and NOT through the request logger.
  if (env.notificationSimulatorEcho) {
    process.stdout.write(`\n[simulated ${message.channel} to ${message.to}]${message.subject ? `\nSubject: ${message.subject}` : ""}\n${message.body}\n\n`);
  }
  if (outbox.length > OUTBOX_LIMIT) {
    outbox.splice(0, outbox.length - OUTBOX_LIMIT);
  }
  return { providerMessageId: message.providerMessageId, accepted: true };
}

/** What the simulator has "delivered", oldest first. A copy: callers cannot mutate it. */
export function simulatedOutbox(): readonly SimulatedMessage[] {
  return [...outbox];
}

export const SIMULATED_PROVIDER_NAME = "simulated";

export class SimulatedNotificationProvider implements NotificationProvider {
  readonly name = SIMULATED_PROVIDER_NAME;

  async sendSms(to: string, body: string): Promise<SendResult> {
    return record({ channel: "SMS", to, subject: null, body, providerMessageId: `sim-${randomUUID()}`, at: new Date() });
  }

  async sendEmail(to: string, subject: string, body: string): Promise<SendResult> {
    return record({ channel: "EMAIL", to, subject, body, providerMessageId: `sim-${randomUUID()}`, at: new Date() });
  }
}
