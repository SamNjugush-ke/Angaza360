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
// FAILURE TREATMENT (documented): reversal is ALWAYS Dr 1100 AR / Cr 1015,
// whether or not a customer is attached. This keeps the trial balance balanced,
// clears 1015 cleanly, and uses only existing accounts (no new suspense account,
// so the chart stays at 44). Allocating the receivable to a specific customer
// sub-ledger is an AR-module concern (a NEXT task); here it lands on the AR GL
// account and the sale is flagged UNSETTLED/PARTIALLY_SETTLED for resolution.
// ===========================================================================

import type { PrismaClient as TenantPrismaClient } from "../../generated/tenant/client";
import type { MpesaTxnStatus } from "../../generated/tenant/enums";
import { assertValidSchemaName, getTenantDb, tenantSchemaFor } from "../../db/tenant";
import { platformDb } from "../../db/platform";
import { resolveTenantContext } from "../../auth/tenant-registry";
import { env } from "../../config/env";
import { postJournalEntryWithinTransaction, type LedgerTx } from "../ledger";
import { getMpesaCallbackParser, getMpesaProviderForTenant } from "./factory";
import { MpesaCallbackAuthError, type MpesaCallback } from "./provider";
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
): Promise<void> {
  const receipt = callback.mpesaReceiptNumber;
  if (receipt === null) {
    throw new Error("Success callback is missing an M-Pesa receipt number.");
  }
  await db.$transaction(async (tx) => {
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
): Promise<void> {
  await db.$transaction(async (tx) => {
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
  });
}

export async function handleCallback(args: {
  rawBody: unknown;
  headers: Record<string, string | undefined>;
  pathSecret: string;
  tenantSlug: string;
}): Promise<CallbackHandlingResult> {
  // Gate 1: the unguessable path secret. 404 (not 401) so the endpoint is not
  // revealed.
  if (args.pathSecret !== env.mpesa.callbackPathSecret) {
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

  if (found.tenderId === null || found.saleId === null) {
    // Defensive: an INITIATED row always has both (set at initiation).
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
      await failTransaction(
        db,
        schema,
        txn,
        "CALLBACK_FAILED",
        callback.resultCode,
        `Amount mismatch: expected ${txn.amount.toString()} cents, callback quoted ${callback.amountCents.toString()} cents.`,
        callback.rawJson,
      );
      return { httpStatus: 200, body: { status: "failed", reason: "amount_mismatch" } };
    }
    if (callback.mpesaReceiptNumber === null) {
      await failTransaction(
        db,
        schema,
        txn,
        "CALLBACK_FAILED",
        callback.resultCode,
        "Success callback without a receipt number.",
        callback.rawJson,
      );
      return { httpStatus: 200, body: { status: "failed", reason: "missing_receipt" } };
    }
    await confirmTransaction(db, schema, txn, callback);
    return { httpStatus: 200, body: { status: "confirmed", receipt: callback.mpesaReceiptNumber } };
  }

  // ResultCode != 0 — user cancelled, insufficient funds, timeout, etc.
  await failTransaction(
    db,
    schema,
    txn,
    "CALLBACK_FAILED",
    callback.resultCode,
    callback.resultDesc,
    callback.rawJson,
  );
  return { httpStatus: 200, body: { status: "failed", resultCode: callback.resultCode } };
}

// Sweep INITIATED transactions older than the cutoff into TIMED_OUT, reversing
// their 1015 clearing exactly like a failure. Run per-tenant by mpesa:expire.
export async function expireStalePending(
  db: TenantPrismaClient,
  olderThanMinutes: number,
): Promise<{ expired: number }> {
  const schema = resolveSchema(db);
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);
  const stale = await db.mpesaTransaction.findMany({
    where: { status: "INITIATED", initiatedAt: { lt: cutoff } },
  });

  let expired = 0;
  for (const found of stale) {
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
    await failTransaction(db, schema, txn, "TIMED_OUT", null, "STK Push timed out with no callback.", null);
    expired += 1;
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
