// ===========================================================================
// KRA eTIMS OSCU provider interface (Module 9, Task 4.1).
//
// Mirrors the M-Pesa pattern exactly (see src/services/mpesa/provider.ts): the
// provider owns ONLY the provider-specific concerns — device initialization and
// invoice submission — and returns a NORMALIZED result. Everything else is
// provider-agnostic and lives in etims-signing.ts: invoice-number allocation,
// persistence, the fiscalStatus transition, retry policy, idempotency.
//
// Two implementations select by env (ETIMS_PROVIDER): SimulatedEtimsProvider
// (default, dev) and RealOscuProvider (real KRA). Going live is a CONFIG change —
// flip ETIMS_PROVIDER and store the tenant's production credentials — never a
// code change to anything below this interface.
//
// ---------------------------------------------------------------------------
// THE THREE OUTCOMES, AND WHY THE DISTINCTION IS THE WHOLE DESIGN
//
//   SIGNED               KRA accepted and signed. The artifacts are fiscal fact.
//   REJECTED             KRA was REACHABLE and REFUSED the payload. The invoice
//                        is rejected; an operator must fix the cause and
//                        resubmit. It is NEVER auto-retried, because retrying a
//                        payload KRA has already refused just refuses again, and
//                        a retry loop hides the real problem.
//   CONNECTIVITY_FAILURE KRA was UNREACHABLE (timeout, DNS, 5xx, network). KRA
//                        has NOT seen this invoice. It is QUEUED and retried
//                        later WITH THE SAME INVOICE NUMBER.
//
// Collapsing the last two into one "failed" would be the single worst mistake
// available here. Treating a rejection as a connectivity failure retries a
// payload that will never be accepted; treating a connectivity failure as a
// rejection abandons an invoice KRA was always going to accept and leaves the
// sale permanently unfiled. OFFLINE is simply the connectivity case, which is why
// no separate offline code path is needed anywhere.
// ---------------------------------------------------------------------------
// ===========================================================================

import type { KraTaxCode } from "../../generated/tenant/enums";
import type { Cents } from "../../lib/money";
import { businessDateTimeParts } from "../../lib/business-time";
import type { EtimsCredentialFields } from "../credentials/provider-schemas";

/** One line of a fiscal invoice, normalized and provider-agnostic. */
export interface EtimsInvoiceLine {
  lineNumber: number;
  /** The product's item code / SKU as KRA will see it. */
  itemCode: string;
  description: string;
  /** Decimal(14,3) string, as everywhere in this system. */
  quantity: string;
  /** Unit price in KES CENTS. Providers convert to KRA's wire format. */
  unitPrice: Cents;
  /** Per-line discount in cents. */
  discount: Cents;
  /** VAT rate as a decimal percentage string, e.g. "16.00". A rate, not money. */
  vatRate: string;
  /**
   * The KRA tax-type code the sale line was CHARGED under (Task 3B.1), read from the
   * sale line — never re-derived here. It is the code the receipt printed, so the
   * invoice KRA receives and the receipt the customer holds cannot disagree.
   */
  taxCode: KraTaxCode;
  /** Line net (ex-VAT) in cents. */
  lineNet: Cents;
  /** Line VAT in cents. */
  lineVat: Cents;
  /** lineNet + lineVat, in cents. */
  lineTotal: Cents;
}

/**
 * A normalized signing request. Deliberately carries NO credential and NO
 * provider-specific field: the credential is passed separately, so a request can
 * be logged or persisted for audit without becoming a stored secret.
 */
export interface EtimsSignRequest {
  /** The invoice number ALREADY ALLOCATED by the signing service. Never minted here. */
  invoiceNumber: number;
  invoiceType: "SALE" | "CREDIT_NOTE";
  /** For a CREDIT_NOTE: the number of the SIGNED invoice being reversed. */
  originalInvoiceNumber?: number;
  /** The system's own sale number, sent as the trader's reference. */
  saleNumber: string;
  /** When the sale actually happened — its business time, not the submission time. */
  salesDate: Date;
  /**
   * The BUYER's KRA PIN, when they gave one. Its presence is the usual reason a
   * sale is fiscally relevant at all: a customer who wants to claim the expense
   * needs an invoice carrying their PIN.
   */
  customerPin: string | null;
  customerName: string | null;
  lines: EtimsInvoiceLine[];
  /** Totals in cents, as the sale already computed them. eTIMS never recomputes money. */
  subtotal: Cents;
  vatTotal: Cents;
  total: Cents;
  /** Free-text reason, required by KRA on a credit note. */
  reason?: string;
}

/** KRA's artifacts for a signed invoice. These ARE the fiscal record. */
export interface EtimsSignedArtifacts {
  kraReceiptNumber: string;
  rcptSign: string;
  intrlData: string;
  sdcDateTime: string;
  qrCodeUrl: string;
}

export type EtimsSignOutcome = "SIGNED" | "REJECTED" | "CONNECTIVITY_FAILURE";

/**
 * The normalized result. A discriminated union, so a caller cannot read
 * artifacts off a rejection or a reason off a success — the type makes the three
 * outcomes impossible to confuse, which is the point of separating them.
 *
 * `rawResponse` is the exact body received (or the error text), kept for audit.
 * `submittedPayload` is what was sent, WITH EVERY SECRET ALREADY STRIPPED by the
 * provider — a persisted request must never carry the cmcKey.
 */
export type EtimsSignResult =
  | {
      outcome: "SIGNED";
      artifacts: EtimsSignedArtifacts;
      submittedPayload: string;
      rawResponse: string;
    }
  | {
      outcome: "REJECTED";
      /** KRA's own result code, as a string: an opaque identifier, not a quantity. */
      resultCode: string;
      resultMsg: string;
      submittedPayload: string;
      rawResponse: string;
    }
  | {
      outcome: "CONNECTIVITY_FAILURE";
      /** Why we could not reach KRA. Never presented as a KRA rejection. */
      resultMsg: string;
      submittedPayload: string;
      rawResponse: string;
    };

/** What device initialization returns: the communication key for every later call. */
export interface EtimsInitResult {
  cmcKey: string;
  rawResponse: string;
}

/**
 * Raised by initializeDevice when KRA refuses or cannot be reached. Initialization
 * is an interactive, operator-triggered act, so unlike signing it may simply fail
 * loudly — there is nothing to queue and nobody waiting at a till.
 */
export class EtimsInitError extends Error {
  readonly reachable: boolean;

  constructor(message: string, reachable: boolean) {
    super(message);
    this.name = "EtimsInitError";
    this.reachable = reachable;
  }
}

export interface EtimsProvider {
  /**
   * KRA's selectInitOsdcInfo(tin, bhfId, dvcSrlNo). STATEFUL AND OCCASIONAL —
   * run at setup or on key expiry, never per sale. Returns the cmcKey that the
   * signing service writes back into the tenant's encrypted credential blob.
   */
  initializeDevice(creds: EtimsCredentialFields): Promise<EtimsInitResult>;

  /**
   * Submit one invoice. MUST NOT throw for an ordinary failure: a rejection and a
   * connectivity failure are both RESULTS, because the signing service has to
   * persist each one differently. It throws only for a programming error.
   */
  signInvoice(
    req: EtimsSignRequest,
    creds: EtimsCredentialFields,
  ): Promise<EtimsSignResult>;

  readonly name: "simulated" | "oscu";
}

// ---------------------------------------------------------------------------
// KRA wire-format helpers, shared by both implementations so the simulator
// emits byte-compatible shapes and the persistence path is identical for real
// and simulated responses.
// ---------------------------------------------------------------------------

/**
 * KRA quotes money as a DECIMAL NUMBER OF SHILLINGS (e.g. 1250.00), while this
 * system stores integer cents. Convert by STRING CONSTRUCTION, never by dividing
 * a float: `Number(cents) / 100` is exactly the floating-point money bug the engineering ledger
 * forbids, and at KES millions it starts losing cents.
 */
export function centsToKraAmount(cents: Cents): string {
  const negative = cents < 0n;
  const magnitude = negative ? -cents : cents;
  const whole = magnitude / 100n;
  const frac = magnitude % 100n;
  return `${negative ? "-" : ""}${whole.toString()}.${frac.toString().padStart(2, "0")}`;
}

/**
 * KRA timestamps are "yyyyMMddHHmmss" in local Kenyan time. Read from the ONE
 * business-time definition (Task H.1) rather than a private "+3 hours".
 */
export function kraDateTime(date: Date): string {
  const p = businessDateTimeParts(date);
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return (
    `${p.year.toString()}${pad(p.month)}${pad(p.day)}` +
    `${pad(p.hour)}${pad(p.minute)}${pad(p.second)}`
  );
}

/** KRA dates are "yyyyMMdd" in local Kenyan time. */
export function kraDate(date: Date): string {
  return kraDateTime(date).slice(0, 8);
}

/**
 * The shape of the OSCU response body both providers parse. KRA returns a
 * resultCd of "000" for success; anything else is a rejection WITH a message.
 * Declared here, once, so the simulator and the real client cannot drift.
 */
export interface OscuResponseEnvelope {
  resultCd?: unknown;
  resultMsg?: unknown;
  resultDt?: unknown;
  data?: unknown;
}

export const OSCU_SUCCESS_CODE = "000";

/** KRA's success code, tolerant of the forms it has been seen in ("000", "0", 0). */
export function isOscuSuccess(resultCd: unknown): boolean {
  if (typeof resultCd === "number") {
    return resultCd === 0;
  }
  if (typeof resultCd !== "string") {
    return false;
  }
  const trimmed = resultCd.trim();
  return trimmed === OSCU_SUCCESS_CODE || trimmed === "0";
}
