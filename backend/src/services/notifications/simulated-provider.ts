// ===========================================================================
// The SIMULATED notification provider (Task T-A3) — the default for both channels.
//
// It performs no network call. It RECORDS each message (channel, recipient,
// rendered subject and body) in an in-process outbox so tests — and a developer
// stepping through a flow — can read what would have been delivered. The outbox is
// memory only: it is never persisted and never logged, because a body can carry a
// raw single-use token. It is bounded, so a long-running dev server cannot grow it
// without limit.
// ===========================================================================

import { randomUUID } from "node:crypto";
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
