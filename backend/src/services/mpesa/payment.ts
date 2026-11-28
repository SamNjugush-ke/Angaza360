// ===========================================================================
// M-Pesa payment service (Task 3.3) — provider-agnostic, the real work.
//
// THIS IS THE ONLY MODULE that writes mpesa_transactions, that flips a
// SaleTender PENDING -> CONFIRMED/FAILED, and that asks the ledger to post the
// confirmation (1015 -> 1010) or reversal (1015 -> 1100 AR) entries. It NEVER
// writes journal tables directly — it calls the ledger's transaction-
// participating entry point. It NEVER writes stock. It touches only the
// MpesaProvider INTERFACE and the normalized MpesaCallback; no simulator- or
// Daraja-specific type appears below.
//
// TASK 3.4 touched exactly ONE line of this module's outbound path: the provider
// is now resolved per-tenant from that tenant's encrypted credential store
// instead of from a process-wide singleton. The reconciliation path below —
// callback handling, the terminal-state idempotency guard, confirmation,
// reversal, and every ledger effect — is byte-for-byte the 3.3 behaviour.
//
// LEDGER TIMING: at sale time the M-Pesa portion sits in 1015 M-Pesa Clearing
// (an asset for money promised via STK but not yet received). On a confirmed
// callback we move it Dr 1010 M-Pesa Till / Cr 1015. On failure/timeout we clear
// it Dr 1100 Accounts Receivable / Cr 1015 — the goods were delivered, so the
// shop is owed that amount; the sale's paymentStatus is downgraded and the
// cashier resolves it (re-tender or void). Either way debits equal credits and
// 1015 nets to zero for the tender.
//
// PRE-SALE (STANDALONE) STK (Task T-B-POS-PAY-A). The POS now takes M-Pesa BEFORE the
// sale exists ("post when paid"): the till pushes an STK for the quoted total, waits for the
// callback, and only then posts the sale. Such a transaction has NO saleId and NO tenderId,
// and its callback records the outcome — status, receipt, raw payload — and posts NOTHING:
// there is no sale yet, so there is no 1015 balance to move, and the money reaches 1010 when
// the paid sale posts. The sale-linked ("post first") path below is RETAINED unchanged for
// any caller that still uses it; the POS does not.
//
// FAILURE TREATMENT (documented): reversal is ALWAYS Dr 1100 AR / Cr 1015,
// whether or not a customer is attached. This keeps the trial balance balanced,
// clears 1015 cleanly, and uses only existing accounts (no new suspense account,
// so the chart stays at 44). Allocating the receivable to a specific customer
// sub-ledger is an AR-module concern (a NEXT task); here it lands on the AR GL
// account and the sale is flagged UNSETTLED/PARTIALLY_SETTLED for resolution.
// ===========================================================================

import { BlockList, isIP } from "node:net";
import { formatCentsKes } from "../../lib/money";
import type { PrismaClient as TenantPrismaClient } from "../../generated/tenant/client";
import type { MpesaTxnStatus } from "../../generated/tenant/enums";
import { assertValidSchemaName, getTenantDb, tenantSchemaFor } from "../../db/tenant";
import { platformDb } from "../../db/platform";
import { resolveTenantContext } from "../../auth/tenant-registry";
import { env } from "../../config/env";
import { postJournalEntryWithinTransaction, type LedgerTx } from "../ledger";
import { getMpesaCallbackParser, getMpesaProviderForTenant } from "./factory";
import { MpesaCallbackAuthError, type MpesaCallback, type StkQueryResult } from "./provider";
import type { TenantContext } from "../../auth/tenant-registry";

const ACCT_MPESA_TILL = "1010";
const ACCT_MPESA_CLEARING = "1015";
const ACCT_ACCOUNTS_RECEIVABLE = "1100";

// Bad initiate input (wrong tender type/status, etc.). Route -> 400.
export class MpesaPaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MpesaPaymentError";
  }
}

function resolveSchema(db: TenantPrismaClient): string {
  const schema = tenantSchemaFor(db);
  assertValidSchemaName(schema);
  return schema;
}

/**
 * THE RACE GUARD (M4.5 W1, T-B2). Locks the transaction row and reports whether it is
 * still INITIATED. Every terminal transition — confirm, fail, time out, reconcile — takes
 * this lock first INSIDE its own transaction, so two callbacks (or a callback and a
 * reconcile) arriving together serialise: the second sees a terminal row and does
 * nothing, instead of posting a second entry and failing on the 0009 guard. Raw SQL, so
 * the table is schema-qualified explicitly (the engineering ledger "Raw SQL and Tenant Schema").
 */
async function lockInitiated(tx: LedgerTx, schema: string, id: string): Promise<boolean> {
  const rows = await tx.$queryRawUnsafe<Array<{ status: string }>>(
    `SELECT "status"::text AS "status" FROM "${schema}"."mpesa_transactions" WHERE "id" = $1 FOR UPDATE`,
    id,
  );
  return rows[0]?.status === "INITIATED";
}

// 1 loyalty point per whole KES 100 (10000 cents), matching sales.ts. M-Pesa
// loyalty was deferred at sale time (the tender was PENDING) and is awarded here
// on confirmation only.
function loyaltyPointsFor(amountCents: bigint): number {
  return Number(amountCents / 10_000n);
}

export interface InitiateStkInput {
  saleId: string;
  tenderId: string;
  phoneNumber: string;
  createdBy: string;
  // The authenticated tenant (Task 3.4). The provider is now constructed from
  // THIS tenant's own encrypted credentials, so the tenant must be named at the
  // call site — it is never inferred from anything client-supplied.
  tenant: TenantContext;
}

export interface InitiateStkResult {
  checkoutRequestId: string;
  mpesaTransactionId: string;
  status: MpesaTxnStatus;
}

export async function initiateStkPushForTender(
  db: TenantPrismaClient,
  input: InitiateStkInput,
): Promise<InitiateStkResult> {
  const tender = await db.saleTender.findUnique({ where: { id: input.tenderId } });
  if (tender === null) {
    throw new MpesaPaymentError(`Tender ${input.tenderId} not found.`);
  }
  if (tender.saleId !== input.saleId) {
    throw new MpesaPaymentError("Tender does not belong to that sale.");
  }
  if (tender.tenderType !== "MPESA") {
    throw new MpesaPaymentError("Only an MPESA tender can be settled by STK Push.");
  }
  if (tender.status !== "PENDING") {
    throw new MpesaPaymentError(`Tender is ${tender.status}, not PENDING; cannot initiate STK Push.`);
  }
  if (tender.mpesaTransactionId !== null) {
    throw new MpesaPaymentError("An STK Push was already initiated for this tender.");
  }
  if (typeof input.phoneNumber !== "string" || input.phoneNumber.trim() === "") {
    throw new MpesaPaymentError("phoneNumber is required.");
  }

  const sale = await db.sale.findUnique({
    where: { id: input.saleId },
    select: { saleNumber: true },
  });
  if (sale === null) {
    throw new MpesaPaymentError(`Sale ${input.saleId} not found.`);
  }

  // Resolve THIS tenant's provider from THIS tenant's credential store (Task
  // 3.4). Throws NoActiveCredentialError / IntegrationDisabledError before
  // anything persists if the tenant has not onboarded M-Pesa.
  const { provider } = await getMpesaProviderForTenant(db, input.tenant);

  // The only network step — outside any transaction. If it throws, nothing
  // persists.
  const push = await provider.initiateStkPush({
    phoneNumber: input.phoneNumber,
    amountCents: tender.amount,
    accountReference: sale.saleNumber,
    description: `Payment for ${sale.saleNumber}`,
  });

  return db.$transaction(async (tx) => {
    const txn = await tx.mpesaTransaction.create({
      data: {
        saleId: input.saleId,
        tenderId: input.tenderId,
        merchantRequestId: push.merchantRequestId,
        checkoutRequestId: push.checkoutRequestId,
        phoneNumber: input.phoneNumber,
        amount: tender.amount,
        accountReference: sale.saleNumber,
        status: "INITIATED",
      },
    });
    await tx.saleTender.update({
      where: { id: input.tenderId },
      data: { mpesaTransactionId: txn.id, mpesaReference: push.checkoutRequestId },
    });
    return { checkoutRequestId: txn.checkoutRequestId, mpesaTransactionId: txn.id, status: txn.status };
  });
}

export interface InitiatePreSaleStkInput {
  phoneNumber: string;
  /** What to ask the customer for, in cents. */
  amountCents: bigint;
  /** Shown on the customer's phone; Daraja allows at most 12 characters. */
  accountReference?: string;
  createdBy: string;
  tenant: TenantContext;
}

/** Daraja's MSISDN form: 254, then a 7xx or 1xx mobile number. */
const MSISDN = /^254[17]\d{8}$/;
const DEFAULT_ACCOUNT_REFERENCE = "POS";

/**
 * A STANDALONE STK Push for a sale that does not exist yet (Task T-B-POS-PAY-A): the money is
 * confirmed BEFORE the sale posts. The row carries no saleId and no tenderId; its callback
 * records the outcome and posts no general ledger. Same provider resolution as the legacy
 * path: THIS tenant's own credentials, no fallback.
 */
export async function initiatePreSaleStkPush(db: TenantPrismaClient, input: InitiatePreSaleStkInput): Promise<InitiateStkResult> {
  const phone = input.phoneNumber.trim();
  if (!MSISDN.test(phone)) {
    throw new MpesaPaymentError("phoneNumber must be a Kenyan mobile number in 2547XXXXXXXX (or 2541XXXXXXXX) form.");
  }
  if (input.amountCents <= 0n) {
    throw new MpesaPaymentError("amount must be greater than zero.");
  }
  const accountReference = (input.accountReference ?? DEFAULT_ACCOUNT_REFERENCE).trim();
  if (accountReference === "" || accountReference.length > 12) {
    throw new MpesaPaymentError("accountReference must be 1 to 12 characters.");
  }

  const { provider } = await getMpesaProviderForTenant(db, input.tenant);
  // The only network step — outside any transaction; if it throws, nothing persists.
  const push = await provider.initiateStkPush({
    phoneNumber: phone,
    amountCents: input.amountCents,
    accountReference,
    description: "POS payment",
  });

  const txn = await db.mpesaTransaction.create({
    data: {
      saleId: null,
      tenderId: null,
      merchantRequestId: push.merchantRequestId,
      checkoutRequestId: push.checkoutRequestId,
      phoneNumber: phone,
      amount: input.amountCents,
      accountReference,
      status: "INITIATED",
    },
  });
  return { checkoutRequestId: txn.checkoutRequestId, mpesaTransactionId: txn.id, status: txn.status };
}

/**
 * Close a PRE-SALE transaction (no sale, no tender) — record the outcome and nothing else. NO
 * journal entry: there is no 1015 balance for it (no sale has posted), and the money is booked
 * to 1010 when the paid sale posts. A terminal row stays final (mpesa_txn_guard).
 */
async function closePreSaleTransaction(
  db: TenantPrismaClient,
  id: string,
  outcome: {
    status: "CALLBACK_OK" | "CALLBACK_FAILED" | "TIMED_OUT";
    resultCode: number | null;
    resultDesc: string;
    receipt: string | null;
    rawJson: string | null;
  },
): Promise<boolean> {
  const schema = resolveSchema(db);
  return db.$transaction(async (tx) => {
    if (!(await lockInitiated(tx, schema, id))) {
      return false;
    }
    await tx.mpesaTransaction.update({
      where: { id },
      data: {
        status: outcome.status,
        resultCode: outcome.resultCode,
        resultDesc: outcome.resultDesc,
        mpesaReceiptNumber: outcome.receipt,
        callbackRawJson: outcome.rawJson,
        completedAt: new Date(),
      },
    });
    return true;
  });
}

export interface CallbackHandlingResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

interface ResolvedTenantDb {
  db: TenantPrismaClient;
  schema: string;
}

// Resolve the tenant from the SERVER-GENERATED callback path slug (never the
// body). Returns null for an unknown or non-ACTIVE tenant — the webhook then
// 404s without revealing anything.
async function resolveTenantDbBySlug(slug: string): Promise<ResolvedTenantDb | null> {
  const tenant = await platformDb.tenant.findUnique({
    where: { subdomain: slug },
    select: { id: true },
  });
  if (tenant === null) {
    return null;
  }
  try {
    const ctx = await resolveTenantContext(tenant.id);
    return { db: getTenantDb(ctx.dbSchema), schema: ctx.dbSchema };
  } catch {
    return null;
  }
}

// Downgrade the sale's paymentStatus after an M-Pesa tender fails/times out.
// PARTIALLY_SETTLED if some other tender is still CONFIRMED, else UNSETTLED.
async function downgradeSalePaymentStatus(
  tx: LedgerTx,
  saleId: string,
  failedTenderId: string,
): Promise<void> {
  const tenders = await tx.saleTender.findMany({ where: { saleId } });
  let settled = 0n;
  for (const tender of tenders) {
    if (tender.id === failedTenderId) {
      continue;
    }
    if (tender.status === "CONFIRMED") {
      settled += tender.amount;
    }
  }
  await tx.sale.update({
    where: { id: saleId },
    data: { paymentStatus: settled > 0n ? "PARTIALLY_SETTLED" : "UNSETTLED" },
  });
}

interface LoadedTxn {
  id: string;
  saleId: string;
  tenderId: string;
  amount: bigint;
  checkoutRequestId: string;
}

// Post the confirmation entry (1015 -> 1010), confirm the tender, mark the txn
// CALLBACK_OK, and award the deferred M-Pesa loyalty. One transaction.
async function confirmTransaction(
  db: TenantPrismaClient,
  schema: string,
  txn: LoadedTxn,
  callback: MpesaCallback,
): Promise<boolean> {
  const receipt = callback.mpesaReceiptNumber;
  if (receipt === null) {
    throw new Error("Success callback is missing an M-Pesa receipt number.");
  }
  return db.$transaction(async (tx) => {
    if (!(await lockInitiated(tx, schema, txn.id))) {
      return false;
    }
    const entry = await postJournalEntryWithinTransaction(tx, schema, {
      entryDate: new Date(),
      description: `M-Pesa settled tender for sale ${txn.saleId} (${receipt})`,
      reference: receipt,
      source: "POS",
      sourceId: txn.saleId,
      createdBy: "mpesa-callback",
      lines: [
        { accountCode: ACCT_MPESA_TILL, debit: txn.amount },
        { accountCode: ACCT_MPESA_CLEARING, credit: txn.amount },
      ],
    });
    await tx.saleTender.update({ where: { id: txn.tenderId }, data: { status: "CONFIRMED" } });
    await tx.mpesaTransaction.update({
      where: { id: txn.id },
      data: {
        status: "CALLBACK_OK",
        resultCode: 0,
        resultDesc: callback.resultDesc,
        mpesaReceiptNumber: receipt,
        callbackRawJson: callback.rawJson,
        confirmationEntryId: entry.id,
        completedAt: new Date(),
      },
    });

    // Award the deferred M-Pesa loyalty portion, now that the money is in.
    const sale = await tx.sale.findUnique({
      where: { id: txn.saleId },
      select: { customerId: true },
    });
    if (sale !== null && sale.customerId !== null) {
      const points = loyaltyPointsFor(txn.amount);
      if (points > 0) {
        const customer = await tx.customer.findUnique({
          where: { id: sale.customerId },
          select: { loyaltyPoints: true },
        });
        if (customer !== null) {
          await tx.customer.update({
            where: { id: sale.customerId },
            data: { loyaltyPoints: customer.loyaltyPoints + points },
          });
        }
      }
    }
    return true;
  });
}

// Post the reversal entry (1015 -> 1100 AR), fail the tender, mark the txn
// terminal, and downgrade the sale. One transaction. Shared by callback-failure,
// amount-mismatch, and timeout paths.
async function failTransaction(
  db: TenantPrismaClient,
  schema: string,
  txn: LoadedTxn,
  terminalStatus: "CALLBACK_FAILED" | "TIMED_OUT",
  resultCode: number | null,
  resultDesc: string,
  rawJson: string | null,
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    if (!(await lockInitiated(tx, schema, txn.id))) {
      return false;
    }
    const reversal = await postJournalEntryWithinTransaction(tx, schema, {
      entryDate: new Date(),
      description: `M-Pesa ${terminalStatus === "TIMED_OUT" ? "timed out" : "failed"} for sale ${txn.saleId}: ${resultDesc}`,
      reference: txn.checkoutRequestId,
      source: "POS",
      sourceId: txn.saleId,
      createdBy: terminalStatus === "TIMED_OUT" ? "mpesa-expire" : "mpesa-callback",
      lines: [
        { accountCode: ACCT_ACCOUNTS_RECEIVABLE, debit: txn.amount },
        { accountCode: ACCT_MPESA_CLEARING, credit: txn.amount },
      ],
    });
    await tx.saleTender.update({ where: { id: txn.tenderId }, data: { status: "FAILED" } });
    await tx.mpesaTransaction.update({
      where: { id: txn.id },
      data: {
        status: terminalStatus,
        resultCode,
        resultDesc,
        callbackRawJson: rawJson,
        reversalEntryId: reversal.id,
        completedAt: new Date(),
      },
    });
    await downgradeSalePaymentStatus(tx, txn.saleId, txn.tenderId);
    return true;
  });
}

/**
 * The callback SOURCE gate (M4.5 W1, T-B2): when MPESA_CALLBACK_IP_ALLOWLIST is set, only
 * those addresses (Safaricom's published callback ranges) may deliver. The client address
 * is `req.ip`, which honours X-Forwarded-For ONLY from TRUST_PROXY, so it cannot be
 * forged. Unset: no source check (the path secret and the INITIATED-row match still gate).
 */
const callbackAllowlist: BlockList | null = (() => {
  if (env.mpesaCallbackAllowlist.length === 0) {
    return null;
  }
  const list = new BlockList();
  for (const entry of env.mpesaCallbackAllowlist) {
    const [address, prefix] = entry.split("/");
    if (address === undefined) continue;
    const family = isIP(address) === 6 ? "ipv6" : "ipv4";
    if (prefix === undefined) {
      list.addAddress(address, family);
    } else {
      list.addSubnet(address, Number(prefix), family);
    }
  }
  return list;
})();

export function callbackSourceAllowed(ip: string): boolean {
  if (callbackAllowlist === null) {
    return true;
  }
  const family = isIP(ip);
  if (family === 0) {
    return false;
  }
  return callbackAllowlist.check(ip, family === 6 ? "ipv6" : "ipv4");
}

export async function handleCallback(args: {
  rawBody: unknown;
  headers: Record<string, string | undefined>;
  pathSecret: string;
  tenantSlug: string;
  /** The verified client address (req.ip). */
  sourceIp: string;
}): Promise<CallbackHandlingResult> {
  // Gate 1: the unguessable path secret. 404 (not 401) so the endpoint is not
  // revealed.
  if (args.pathSecret !== env.mpesa.callbackPathSecret) {
    return { httpStatus: 404, body: { error: "Not found" } };
  }
  // Gate 2 (T-B2): the source address, when an allowlist is configured. Same 404.
  if (!callbackSourceAllowed(args.sourceIp)) {
    return { httpStatus: 404, body: { error: "Not found" } };
  }

  // Parse + verify the wire format. Malformed/inauthentic -> 400, no side
  // effect. This needs NO credentials, which is why it still runs before the
  // tenant is resolved — unchanged from 3.3.
  const parser = getMpesaCallbackParser();
  let callback: MpesaCallback;
  try {
    callback = parser.parseAndVerifyCallback(args.rawBody, args.headers);
  } catch (error) {
    if (error instanceof MpesaCallbackAuthError) {
      return { httpStatus: 400, body: { error: "BadCallback", message: error.message } };
    }
    throw error;
  }

  // Resolve the tenant from the server-generated path slug.
  const resolved = await resolveTenantDbBySlug(args.tenantSlug);
  if (resolved === null) {
    return { httpStatus: 404, body: { error: "Not found" } };
  }
  const { db, schema } = resolved;

  const found = await db.mpesaTransaction.findUnique({
    where: { checkoutRequestId: callback.checkoutRequestId },
  });
  // Unknown to this tenant (wrong slug, cross-tenant probe, or unknown id):
  // 200 no-op, no ledger effect. (Well-formed but not ours — do not make
  // Safaricom retry.)
  if (found === null) {
    return {
      httpStatus: 200,
      body: { status: "ignored", reason: "unknown checkoutRequestId for this tenant" },
    };
  }

  // IDEMPOTENCY: a terminal transaction is final. A duplicate/replayed callback
  // returns 200 and does NOTHING — no second GL entry, no re-confirm. The DB
  // trigger backstops this.
  if (found.status !== "INITIATED") {
    return {
      httpStatus: 200,
      body: { status: "already_processed", transactionStatus: found.status },
    };
  }

  // SHAPE AUTHENTICITY (T-B2). A callback whose MerchantRequestID disagrees with the one
  // Safaricom gave us at push time is not about this push: ignored, no side effect.
  if (callback.merchantRequestId !== null && found.merchantRequestId !== null && callback.merchantRequestId !== found.merchantRequestId) {
    return { httpStatus: 200, body: { status: "ignored", reason: "MerchantRequestID does not match the push" } };
  }
  // A receipt already recorded on ANOTHER transaction cannot settle this one: an M-Pesa
  // receipt is one payment. Ignored (the push stays INITIATED for reconciliation), never
  // a second confirmation of the same money.
  if (callback.resultCode === 0 && callback.mpesaReceiptNumber !== null) {
    const holder = await db.mpesaTransaction.findUnique({ where: { mpesaReceiptNumber: callback.mpesaReceiptNumber }, select: { id: true } });
    if (holder !== null && holder.id !== found.id) {
      return { httpStatus: 200, body: { status: "ignored", reason: "receipt already settles another transaction" } };
    }
  }
  const alreadyProcessed = (): CallbackHandlingResult => ({ httpStatus: 200, body: { status: "already_processed" } });

  // PRE-SALE (Task T-B-POS-PAY-A): no sale and no tender — record the outcome, post nothing.
  if (found.tenderId === null && found.saleId === null) {
    if (callback.resultCode === 0) {
      if (callback.amountCents !== null && callback.amountCents !== found.amount) {
        const closed = await closePreSaleTransaction(db, found.id, {
          status: "CALLBACK_FAILED",
          resultCode: callback.resultCode,
          resultDesc: `Amount mismatch: expected ${formatCentsKes(found.amount)}, callback quoted ${formatCentsKes(callback.amountCents)}.`,
          receipt: null,
          rawJson: callback.rawJson,
        });
        return closed ? { httpStatus: 200, body: { status: "failed", reason: "amount_mismatch" } } : alreadyProcessed();
      }
      if (callback.mpesaReceiptNumber === null) {
        const closed = await closePreSaleTransaction(db, found.id, {
          status: "CALLBACK_FAILED",
          resultCode: callback.resultCode,
          resultDesc: "Success callback without a receipt number.",
          receipt: null,
          rawJson: callback.rawJson,
        });
        return closed ? { httpStatus: 200, body: { status: "failed", reason: "missing_receipt" } } : alreadyProcessed();
      }
      const closed = await closePreSaleTransaction(db, found.id, {
        status: "CALLBACK_OK",
        resultCode: 0,
        resultDesc: callback.resultDesc,
        receipt: callback.mpesaReceiptNumber,
        rawJson: callback.rawJson,
      });
      return closed ? { httpStatus: 200, body: { status: "confirmed", receipt: callback.mpesaReceiptNumber } } : alreadyProcessed();
    }
    const closed = await closePreSaleTransaction(db, found.id, {
      status: "CALLBACK_FAILED",
      resultCode: callback.resultCode,
      resultDesc: callback.resultDesc,
      receipt: null,
      rawJson: callback.rawJson,
    });
    return closed ? { httpStatus: 200, body: { status: "failed", resultCode: callback.resultCode } } : alreadyProcessed();
  }

  if (found.tenderId === null || found.saleId === null) {
    // Defensive: a sale-linked row always has both (set at initiation).
    return { httpStatus: 200, body: { status: "ignored", reason: "transaction has no linked tender" } };
  }
  const txn: LoadedTxn = {
    id: found.id,
    saleId: found.saleId,
    tenderId: found.tenderId,
    amount: found.amount,
    checkoutRequestId: found.checkoutRequestId,
  };

  if (callback.resultCode === 0) {
    // Amount authenticity: the callback amount must match what we asked for.
    if (callback.amountCents !== null && callback.amountCents !== txn.amount) {
      const failed = await failTransaction(
        db,
        schema,
        txn,
        "CALLBACK_FAILED",
        callback.resultCode,
        `Amount mismatch: expected ${formatCentsKes(txn.amount)}, callback quoted ${formatCentsKes(callback.amountCents)}.`,
        callback.rawJson,
      );
      return failed ? { httpStatus: 200, body: { status: "failed", reason: "amount_mismatch" } } : alreadyProcessed();
    }
    if (callback.mpesaReceiptNumber === null) {
      const failed = await failTransaction(
        db,
        schema,
        txn,
        "CALLBACK_FAILED",
        callback.resultCode,
        "Success callback without a receipt number.",
        callback.rawJson,
      );
      return failed ? { httpStatus: 200, body: { status: "failed", reason: "missing_receipt" } } : alreadyProcessed();
    }
    const confirmed = await confirmTransaction(db, schema, txn, callback);
    return confirmed ? { httpStatus: 200, body: { status: "confirmed", receipt: callback.mpesaReceiptNumber } } : alreadyProcessed();
  }

  // ResultCode != 0 — user cancelled, insufficient funds, timeout, etc.
  const failed = await failTransaction(
    db,
    schema,
    txn,
    "CALLBACK_FAILED",
    callback.resultCode,
    callback.resultDesc,
    callback.rawJson,
  );
  return failed ? { httpStatus: 200, body: { status: "failed", resultCode: callback.resultCode } } : alreadyProcessed();
}

// Sweep INITIATED transactions older than the cutoff into TIMED_OUT. A sale-linked one has
// its 1015 clearing reversed exactly like a failure; a PRE-SALE one (no sale, no tender) is
// simply recorded TIMED_OUT with no GL, because nothing was ever posted for it. Run per-tenant
// by mpesa:expire.
export async function expireStalePending(
  db: TenantPrismaClient,
  olderThanMinutes: number,
): Promise<{ expired: number }> {
  const schema = resolveSchema(db);
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);
  // A push Safaricom's STK query says was PAID (queryResultCode = 0) is NEVER timed out:
  // the money arrived and only its receipt is missing (T-B2).
  const stale = await db.mpesaTransaction.findMany({
    where: {
      status: "INITIATED",
      initiatedAt: { lt: cutoff },
      OR: [{ queryResultCode: null }, { queryResultCode: { not: 0 } }],
    },
  });

  let expired = 0;
  for (const found of stale) {
    // A PRE-SALE push abandoned without a callback: TIMED_OUT, recorded, no GL (nothing posted).
    if (found.tenderId === null && found.saleId === null) {
      if (
        await closePreSaleTransaction(db, found.id, {
          status: "TIMED_OUT",
          resultCode: null,
          resultDesc: "STK Push timed out with no callback.",
          receipt: null,
          rawJson: null,
        })
      ) {
        expired += 1;
      }
      continue;
    }
    if (found.tenderId === null || found.saleId === null) {
      continue;
    }
    const txn: LoadedTxn = {
      id: found.id,
      saleId: found.saleId,
      tenderId: found.tenderId,
      amount: found.amount,
      checkoutRequestId: found.checkoutRequestId,
    };
    if (await failTransaction(db, schema, txn, "TIMED_OUT", null, "STK Push timed out with no callback.", null)) {
      expired += 1;
    }
  }
  return { expired };
}

export async function getMpesaTransactionStatus(
  db: TenantPrismaClient,
  checkoutRequestId: string,
): Promise<{
  checkoutRequestId: string;
  status: MpesaTxnStatus;
  amount: bigint;
  resultCode: number | null;
  resultDesc: string | null;
  mpesaReceiptNumber: string | null;
  saleId: string | null;
  tenderId: string | null;
} | null> {
  const txn = await db.mpesaTransaction.findUnique({ where: { checkoutRequestId } });
  if (txn === null) {
    return null;
  }
  return {
    checkoutRequestId: txn.checkoutRequestId,
    status: txn.status,
    amount: txn.amount,
    resultCode: txn.resultCode,
    resultDesc: txn.resultDesc,
    mpesaReceiptNumber: txn.mpesaReceiptNumber,
    saleId: txn.saleId,
    tenderId: txn.tenderId,
  };
}

// ===========================================================================
// RECONCILIATION (M4.5 W1, T-B2) — asking Safaricom about pushes whose callback is late.
//
// A callback can be lost (network, an outage on either side). The reconcile service asks
// the provider (STK Push Query) about every INITIATED push older than `olderThanMinutes`
// and resolves what it can, IDEMPOTENTLY — every terminal transition goes through the same
// row-locked paths as a callback, so running it twice, or racing a late callback, can never
// post twice:
//
//   FAILED    the push definitively failed: closed CALLBACK_FAILED exactly like a failure
//             callback (a legacy sale-linked push clears 1015 -> 1100; a pre-sale push posts
//             nothing).
//   SUCCESS   the money ARRIVED, but the query carries NO receipt, and CALLBACK_OK demands
//             one (`mpesa_ok_requires_receipt` — success is only success with proof). So the
//             row stays INITIATED, is marked paid (queryResultCode 0), is never timed out,
//             and is reported PAID_AWAITING_RECEIPT. `resolveWithReceipt` completes it with
//             the receipt from the callback-less record (the customer's SMS or the M-Pesa
//             portal) through the very same confirmation path.
//   PENDING   still being processed: recorded, left alone.
//   error     the query itself failed (network, credentials): recorded, left alone.
//
// Scheduled in Wave 4; here it is a service plus a manual trigger (route and CLI).
// ===========================================================================

export interface ReconcileOutcome {
  readonly checkoutRequestId: string;
  readonly result: "RESOLVED_FAILED" | "PAID_AWAITING_RECEIPT" | "STILL_PENDING" | "QUERY_ERROR" | "ALREADY_TERMINAL";
  readonly detail: string;
}

export interface ReconcileReport {
  readonly examined: number;
  readonly outcomes: ReconcileOutcome[];
}

async function recordQuery(
  db: TenantPrismaClient,
  id: string,
  result: { resultCode: number | null; resultDesc: string },
): Promise<void> {
  const schema = resolveSchema(db);
  await db.$transaction(async (tx) => {
    if (!(await lockInitiated(tx, schema, id))) {
      return;
    }
    await tx.mpesaTransaction.update({
      where: { id },
      data: {
        lastQueriedAt: new Date(),
        queryCount: { increment: 1 },
        queryResultCode: result.resultCode,
        queryResultDesc: result.resultDesc.slice(0, 300),
      },
    });
  });
}

export async function reconcilePendingMpesa(
  db: TenantPrismaClient,
  tenant: TenantContext,
  options: { olderThanMinutes: number },
): Promise<ReconcileReport> {
  const schema = resolveSchema(db);
  const cutoff = new Date(Date.now() - options.olderThanMinutes * 60_000);
  const pending = await db.mpesaTransaction.findMany({
    where: {
      status: "INITIATED",
      initiatedAt: { lt: cutoff },
      // Already known to be paid: asking again cannot produce the receipt.
      OR: [{ queryResultCode: null }, { queryResultCode: { not: 0 } }],
    },
    orderBy: [{ initiatedAt: "asc" }, { id: "asc" }],
    take: 200,
  });
  if (pending.length === 0) {
    return { examined: 0, outcomes: [] };
  }
  const { provider } = await getMpesaProviderForTenant(db, tenant);
  const outcomes: ReconcileOutcome[] = [];
  for (const found of pending) {
    let query: StkQueryResult;
    try {
      query = await provider.queryStkStatus(found.checkoutRequestId);
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 300) : "STK query failed.";
      await recordQuery(db, found.id, { resultCode: null, resultDesc: `Query failed: ${detail}` });
      outcomes.push({ checkoutRequestId: found.checkoutRequestId, result: "QUERY_ERROR", detail });
      continue;
    }
    await recordQuery(db, found.id, { resultCode: query.resultCode, resultDesc: query.resultDesc });
    if (query.kind === "PENDING") {
      outcomes.push({ checkoutRequestId: found.checkoutRequestId, result: "STILL_PENDING", detail: query.resultDesc });
      continue;
    }
    if (query.kind === "SUCCESS") {
      outcomes.push({ checkoutRequestId: found.checkoutRequestId, result: "PAID_AWAITING_RECEIPT", detail: query.resultDesc });
      continue;
    }
    const desc = `Reconciled by STK query: ${query.resultDesc}`;
    let closed: boolean;
    if (found.tenderId === null && found.saleId === null) {
      closed = await closePreSaleTransaction(db, found.id, {
        status: "CALLBACK_FAILED",
        resultCode: query.resultCode,
        resultDesc: desc,
        receipt: null,
        rawJson: null,
      });
    } else if (found.tenderId !== null && found.saleId !== null) {
      closed = await failTransaction(
        db,
        schema,
        { id: found.id, saleId: found.saleId, tenderId: found.tenderId, amount: found.amount, checkoutRequestId: found.checkoutRequestId },
        "CALLBACK_FAILED",
        query.resultCode,
        desc,
        null,
      );
    } else {
      closed = false;
    }
    outcomes.push({
      checkoutRequestId: found.checkoutRequestId,
      result: closed ? "RESOLVED_FAILED" : "ALREADY_TERMINAL",
      detail: query.resultDesc,
    });
  }
  return { examined: pending.length, outcomes };
}

/** Thrown when a paid-awaiting-receipt resolution is not possible. Route -> 409. */
export class MpesaResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MpesaResolveError";
  }
}

/**
 * Completes a push Safaricom's query CONFIRMED paid but whose callback never came, with
 * the M-Pesa receipt (from the customer's message or the M-Pesa portal). Only a push the
 * query marked paid (queryResultCode 0) can be resolved this way — never a guess. It goes
 * through the SAME locked confirmation path as a callback, so it is idempotent: a second
 * call, or a late callback, finds the row terminal and does nothing.
 */
export async function resolveWithReceipt(
  db: TenantPrismaClient,
  checkoutRequestId: string,
  receipt: string,
): Promise<{ status: "confirmed" | "already_processed" }> {
  const schema = resolveSchema(db);
  const found = await db.mpesaTransaction.findUnique({ where: { checkoutRequestId } });
  if (found === null) {
    throw new MpesaPaymentError("No M-Pesa transaction with that id.");
  }
  if (found.status !== "INITIATED") {
    return { status: "already_processed" };
  }
  if (found.queryResultCode !== 0) {
    throw new MpesaResolveError("Only a push the M-Pesa query confirmed as PAID can be completed with a receipt. Reconcile it first.");
  }
  const holder = await db.mpesaTransaction.findUnique({ where: { mpesaReceiptNumber: receipt }, select: { id: true } });
  if (holder !== null && holder.id !== found.id) {
    throw new MpesaResolveError("That M-Pesa receipt already settles another transaction.");
  }
  const callback: MpesaCallback = {
    checkoutRequestId,
    merchantRequestId: found.merchantRequestId,
    resultCode: 0,
    resultDesc: "Confirmed by STK query; receipt entered on reconciliation.",
    mpesaReceiptNumber: receipt,
    amountCents: found.amount,
    phoneNumber: found.phoneNumber,
    rawJson: JSON.stringify({ source: "reconciliation", receipt }),
  };
  if (found.tenderId === null && found.saleId === null) {
    const closed = await closePreSaleTransaction(db, found.id, {
      status: "CALLBACK_OK",
      resultCode: 0,
      resultDesc: callback.resultDesc,
      receipt,
      rawJson: callback.rawJson,
    });
    return { status: closed ? "confirmed" : "already_processed" };
  }
  if (found.tenderId === null || found.saleId === null) {
    throw new MpesaResolveError("The transaction is linked inconsistently; it cannot be resolved here.");
  }
  const confirmed = await confirmTransaction(
    db,
    schema,
    { id: found.id, saleId: found.saleId, tenderId: found.tenderId, amount: found.amount, checkoutRequestId },
    callback,
  );
  return { status: confirmed ? "confirmed" : "already_processed" };
}
