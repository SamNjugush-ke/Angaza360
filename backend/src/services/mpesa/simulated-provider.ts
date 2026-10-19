// ===========================================================================
// Simulated M-Pesa provider (Task 3.3, default for MVP dev). It mints STK
// correlation ids but does NOT auto-deliver callbacks — that would make tests
// racy. Instead, tests drive callbacks deterministically through a guarded dev
// route (POST /v1/dev/mpesa/deliver), which builds a byte-compatible Daraja
// stkCallback envelope with buildSimulatedCallbackEnvelope() below and fires it
// into the REAL webhook path via Fastify in-process injection (no network, no
// flakiness). Because the envelope is byte-compatible with Daraja's, the webhook
// parses ONE shape — which is exactly what guarantees the config-only swap.
//
// Outcome control: the dev route passes an explicit outcome
// ("success" | "failure" | "amount_mismatch") to buildSimulatedCallbackEnvelope,
// so a test steers success, failure, and mismatch deterministically.
// ===========================================================================

import { randomUUID, randomBytes } from "node:crypto";
import {
  MpesaCallbackAuthError,
  parseDarajaEnvelope,
  type DarajaStkCallbackEnvelope,
  type MpesaCallback,
  type MpesaCallbackParser,
  type MpesaProvider,
  type StkPushRequest,
  type StkPushResult,
} from "./provider";

export type SimulatedOutcome = "success" | "failure" | "amount_mismatch";

// Callback parsing needs no credentials, so it is split out (Task 3.4) exactly
// as it is for Daraja — see DarajaCallbackParser.
export class SimulatedCallbackParser implements MpesaCallbackParser {
  readonly name = "simulated" as const;

  parseAndVerifyCallback(rawBody: unknown): MpesaCallback {
    // The simulator trusts the source (it is our own dev route) but still
    // validates structure — malformed still throws MpesaCallbackAuthError.
    return parseDarajaEnvelope(rawBody);
  }
}

export class SimulatedMpesaProvider extends SimulatedCallbackParser implements MpesaProvider {
  async initiateStkPush(req: StkPushRequest): Promise<StkPushResult> {
    if (req.amountCents <= 0n) {
      throw new Error("STK amount must be positive.");
    }
    // No network; mint Daraja-shaped correlation ids and return immediately.
    // Deterministic delivery happens later via the dev deliver route.
    return {
      merchantRequestId: `sim-mreq-${randomUUID()}`,
      checkoutRequestId: `ws_CO_${randomUUID()}`,
    };
  }
}

interface SimulatedCallbackParams {
  merchantRequestId: string | null;
  checkoutRequestId: string;
  amountCents: bigint; // the transaction's true amount, in cents
  phoneNumber: string;
}

function generateReceiptNumber(): string {
  // Daraja-style receipt, e.g. "SIMQK12ABC3". Uppercase alphanumerics.
  return "SIM" + randomBytes(6).toString("hex").toUpperCase().slice(0, 8);
}

// Build a byte-compatible Daraja stkCallback envelope for a given outcome.
// Amount is emitted in WHOLE SHILLINGS (Daraja convention). "amount_mismatch"
// deliberately quotes a different amount so the confirmation amount check fails.
export function buildSimulatedCallbackEnvelope(
  params: SimulatedCallbackParams,
  outcome: SimulatedOutcome,
): DarajaStkCallbackEnvelope {
  if (params.amountCents % 100n !== 0n) {
    // Simulator only deals in whole shillings, like the real thing.
    throw new MpesaCallbackAuthError("Simulated amount is not a whole shilling.");
  }
  const shillings = params.amountCents / 100n;

  if (outcome === "failure") {
    return {
      Body: {
        stkCallback: {
          ...(params.merchantRequestId !== null
            ? { MerchantRequestID: params.merchantRequestId }
            : {}),
          CheckoutRequestID: params.checkoutRequestId,
          ResultCode: 1032,
          ResultDesc: "Request cancelled by user.",
        },
      },
    };
  }

  const quotedShillings = outcome === "amount_mismatch" ? shillings + 1n : shillings;
  return {
    Body: {
      stkCallback: {
        ...(params.merchantRequestId !== null
          ? { MerchantRequestID: params.merchantRequestId }
          : {}),
        CheckoutRequestID: params.checkoutRequestId,
        ResultCode: 0,
        ResultDesc: "The service request is processed successfully.",
        CallbackMetadata: {
          Item: [
            { Name: "Amount", Value: Number(quotedShillings) },
            { Name: "MpesaReceiptNumber", Value: generateReceiptNumber() },
            { Name: "PhoneNumber", Value: params.phoneNumber },
          ],
        },
      },
    },
  };
}
