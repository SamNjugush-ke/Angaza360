import { centsToAmount, formatKES, parseCents, parseMajorToCents } from "@/lib/money";
import type { Customer, MpesaChannel, SaleTenderBody, TillTenderType } from "./types";

// Taking payment — pure, in integer cents. The total is the QUOTE's; the till only checks that
// what the cashier keyed in adds up to it, works out the change, and refuses (before the server
// does) a credit tender with no customer or beyond the customer's credit, and an M-Pesa tender
// that is not yet confirmed. Amounts the cashier types are shillings; every comparison is BigInt
// cents through the one money parser — never a number.

/**
 * An M-Pesa tender's confirmation. STK: the till prompts the customer's phone (a PRE-SALE push)
 * and polls until M-Pesa answers — only a CONFIRMED push may be charged, and it is sent as its
 * checkout id. MANUAL: the cashier read the payment off the customer's message (a Till or Paybill
 * payment, or an STK that answered late) and keys in its code and channel.
 */
export type MpesaTender =
  | {
      mode: "stk";
      phone: string;
      /** draft: not prompted yet · waiting: prompted, M-Pesa has not answered · confirmed: paid · failed: refused or timed out · quiet: no answer after the wait. */
      stage: "draft" | "waiting" | "confirmed" | "failed" | "quiet";
      checkoutRequestId: string | null;
      /** When the push was sent (ms), to stop waiting on a prompt nobody answers. */
      sentAt: number | null;
      receiptNumber: string | null;
      failure: string | null;
    }
  | { mode: "manual"; channel: MpesaChannel; reference: string };

export interface TenderLine {
  id: string;
  type: TillTenderType;
  /** What this tender pays towards the sale, in shillings as typed. */
  amount: string;
  /** CASH only: the notes handed over, in shillings as typed ("" when not entered). */
  cashReceived: string;
  /** MPESA only. */
  mpesa: MpesaTender | null;
  /** The total moved since this amount was set; the cashier must look at it again. */
  stale: boolean;
}

export interface TenderEvaluation {
  tendered: bigint;
  outstanding: bigint;
  change: bigint;
  credit: bigint;
  /** A message per tender id that cannot be charged as it stands. */
  problems: Readonly<Record<string, string>>;
  /** A problem with the payment as a whole (credit without a customer, over the limit). */
  blocking: string | null;
  canCharge: boolean;
}

/** A typed shilling amount in cents, or null when it is empty or not an amount. */
export function typedCents(typed: string): bigint | null {
  return cents(typed);
}

function cents(typed: string): bigint | null {
  if (typed.trim() === "") return null;
  try {
    return parseMajorToCents(typed);
  } catch {
    return null;
  }
}

const MPESA_CODE = /^[A-Za-z0-9]{6,20}$/;

/** Why an M-Pesa tender cannot be charged yet, or null when it is confirmed. */
function mpesaProblem(mpesa: MpesaTender | null): string | null {
  if (mpesa === null) return "Choose how the customer paid by M-Pesa.";
  if (mpesa.mode === "manual") {
    if (mpesa.reference.trim() === "") return "Enter the M-Pesa code from the customer's message.";
    if (!MPESA_CODE.test(mpesa.reference.trim())) return "An M-Pesa code is letters and numbers only, e.g. QK7AB12CDE.";
    return null;
  }
  switch (mpesa.stage) {
    case "confirmed":
      return null;
    case "draft":
      return "Prompt the customer's phone, or enter the M-Pesa code instead.";
    case "waiting":
      return "Waiting for the customer to enter their M-Pesa PIN.";
    default:
      return mpesa.failure ?? "M-Pesa has not confirmed this payment.";
  }
}

export function evaluateTenders(lines: readonly TenderLine[], total: bigint, customer: Customer | null): TenderEvaluation {
  const problems: Record<string, string> = {};
  let tendered = 0n;
  let change = 0n;
  let credit = 0n;
  for (const line of lines) {
    const amount = cents(line.amount);
    if (amount === null || amount <= 0n) {
      problems[line.id] = line.stale ? "The total changed. Enter this amount again." : "Enter an amount above 0, in shillings.";
      continue;
    }
    tendered += amount;
    if (line.type === "CREDIT") credit += amount;
    if (line.type === "MPESA") {
      const problem = mpesaProblem(line.mpesa);
      if (problem !== null) problems[line.id] = problem;
    }
    if (line.type === "CASH" && line.cashReceived.trim() !== "") {
      const received = cents(line.cashReceived);
      if (received === null) problems[line.id] = "Enter the cash received in shillings, e.g. 2,000.";
      else if (received < amount) problems[line.id] = "The cash received is less than this payment.";
      else change += received - amount;
    }
  }
  let blocking: string | null = null;
  if (credit > 0n && customer === null) {
    blocking = "Credit needs a customer. Add the customer before charging.";
  } else if (credit > 0n && customer !== null) {
    const left = parseCents(customer.creditLimit) - parseCents(customer.creditBalance);
    if (credit > left) {
      blocking = `${customer.name} has KES ${formatKES(left < 0n ? 0n : left)} of credit left; this puts KES ${formatKES(credit)} on credit.`;
    }
  }
  const outstanding = total - tendered;
  return {
    tendered,
    outstanding,
    change,
    credit,
    problems,
    blocking,
    canCharge: lines.length > 0 && total > 0n && outstanding === 0n && Object.keys(problems).length === 0 && blocking === null,
  };
}

/** The sale's tenders as the API takes them: amounts as decimal shilling strings. */
export function tendersToBody(lines: readonly TenderLine[]): SaleTenderBody[] {
  return lines.map((line): SaleTenderBody => {
    const amount = centsToAmount(parseMajorToCents(line.amount));
    if (line.type === "CASH" && line.cashReceived.trim() !== "") {
      return { tenderType: "CASH", amount, cashReceived: centsToAmount(parseMajorToCents(line.cashReceived)) };
    }
    if (line.type === "MPESA" && line.mpesa !== null) {
      if (line.mpesa.mode === "manual") {
        return { tenderType: "MPESA", amount, mpesaChannel: line.mpesa.channel, mpesaReference: line.mpesa.reference.trim().toUpperCase() };
      }
      // Only a confirmed push is ever charged (evaluateTenders), and it travels as its checkout id.
      return { tenderType: "MPESA", amount, mpesaChannel: "STK", mpesaCheckoutRequestId: line.mpesa.checkoutRequestId ?? "" };
    }
    return { tenderType: line.type, amount };
  });
}

/**
 * Whether a tender stands for M-Pesa money that is already in, or may be on its way: a confirmed
 * push, or one the customer is still answering. Such a payment cannot be thrown away to edit the
 * cart — undoing money received is a refund, not an edit.
 */
export function holdsMpesaMoney(line: TenderLine): boolean {
  return line.mpesa?.mode === "stk" && (line.mpesa.stage === "confirmed" || line.mpesa.stage === "waiting");
}

/**
 * Whether the cashier may still change this tender's amount. A pushed STK asked the customer for
 * an exact figure; the amount is fixed once the prompt is sent.
 */
export function amountEditable(line: TenderLine): boolean {
  return !(line.mpesa?.mode === "stk" && line.mpesa.stage !== "draft" && line.mpesa.stage !== "failed" && line.mpesa.stage !== "quiet");
}

/**
 * After a re-quote moved the total: an M-Pesa push not yet answered for — un-prompted, refused or
 * unanswered — has its amount cleared and is flagged, so the customer's phone is never prompted
 * for the old total. Money already in (cash, bank, credit, a confirmed or manually read M-Pesa
 * payment) keeps its amount; the running outstanding shows what is left to settle.
 */
export function markStale(lines: readonly TenderLine[]): TenderLine[] {
  return lines.map((line) =>
    line.type === "MPESA" && line.mpesa?.mode === "stk" && amountEditable(line) && line.amount !== "" ? { ...line, amount: "", stale: true } : line,
  );
}

let nextId = 0;
export function newTender(type: TillTenderType, amountCents: bigint): TenderLine {
  nextId += 1;
  return {
    id: `t${nextId.toString()}`,
    type,
    amount: amountCents > 0n ? centsToAmount(amountCents) : "",
    cashReceived: "",
    mpesa: type === "MPESA" ? draftStk() : null,
    stale: false,
  };
}

export function draftStk(phone = ""): MpesaTender {
  return { mode: "stk", phone, stage: "draft", checkoutRequestId: null, sentAt: null, receiptNumber: null, failure: null };
}

/**
 * A Kenyan mobile number in the form M-Pesa takes (2547XXXXXXXX / 2541XXXXXXXX), from how a
 * cashier types it: 0712 345 678, +254 712 345 678, 712345678. Null when it is not one.
 */
export function toMsisdn(typed: string): string | null {
  const digits = typed.replace(/[\s()-]/g, "").replace(/^\+/, "");
  let national: string;
  if (/^254\d{9}$/.test(digits)) national = digits.slice(3);
  else if (/^0\d{9}$/.test(digits)) national = digits.slice(1);
  else if (/^\d{9}$/.test(digits)) national = digits;
  else return null;
  return /^[17]\d{8}$/.test(national) ? `254${national}` : null;
}
