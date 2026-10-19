// ===========================================================================
// ACCOUNTS RECEIVABLE — CUSTOMER RECEIPTS AND ALLOCATION (Module 6, Task 6)
//
// THIS IS THE ONLY MODULE PERMITTED TO WRITE `customer_receipts` OR
// `customer_receipt_allocations`, and the only module that posts the
// AR-SETTLEMENT general ledger.
//
// WHAT IT MUST NEVER DO:
//   * IT NEVER WRITES A STOCK TABLE. Collecting a debt moves no goods.
//   * IT NEVER POSTS TO 1200, TO ANY REVENUE ACCOUNT, OR TO 2100 VAT OUTPUT.
//     **The sale already did all three**, at the till, when it was rung up. A
//     receipt that touched revenue would recognise the same sale's income twice,
//     and one that touched output VAT would declare the same tax twice to KRA.
//     A receipt moves ONE asset into ANOTHER: `Dr cash / Cr receivable`.
//
// ---------------------------------------------------------------------------
// WHY THIS MODULE IS SMALLER THAN PAYABLES, AND WHAT THAT MEANS
//
// A CREDIT SALE ALREADY IS THE RECEIVABLE DOCUMENT. `src/services/sales.ts` posted
// `Dr 1100 Accounts Receivable / Cr 4000 revenue (+ Cr 2100 output VAT)` and raised
// `Customer.creditBalance` by the CREDIT-tender portion, all inside the sale's own
// transaction. So unlike accounts payable there is:
//   * no invoice entity to create (the sale is it);
//   * no GRNI analogue (nothing was received on account ahead of a document);
//   * no price variance (we set the price);
//   * no VAT to recognise (output VAT was declared at the point of sale).
//
// This module adds exactly one thing: the money coming BACK.
// ---------------------------------------------------------------------------
// THE RECEIVABLE IS DERIVED, NEVER STORED
//
// Per sale it is `SUM(its CREDIT SaleTender amounts)`, and sale tenders are
// WRITE-ONCE (migration 0006 refuses UPDATE and DELETE on them). So the derivation
// cannot go stale, and there is deliberately no `arOriginal` column that could
// disagree with the tenders it claims to total. Outstanding is
// `SUM(credit tenders) - Sale.arReceived`, and `arReceived` is the ONE new mutable
// fact — a cache of the allocations, pinned to them by a deferred constraint.
//
// NOTE WHICH TENDERS COUNT. Only `tenderType = 'CREDIT'`. A FAILED M-Pesa tender
// also debited 1100 (Task 3.3 moves `Dr 1100 / Cr 1015` when an STK Push fails or
// times out, because the goods went out of the door), but it is an MPESA tender and
// carries no customer attribution, so it is NOT part of the customer subledger. That
// is the reconciling residual documented in the engineering ledger "Accounts Receivable", and it
// is deliberately left alone: re-plumbing it would change a settled Task 3.3
// guarantee.
// ---------------------------------------------------------------------------
// THE `Customer.creditBalance` WRITER PARTITION — read this before touching it
//
// `creditBalance` is the ONE column in this system with TWO writers, and the split
// is strictly by direction:
//
//   `src/services/sales.ts`        RAISES it by the CREDIT-tender portion when a
//                                  credit sale is recorded, and LOWERS it by the
//                                  same when that sale is VOIDED.
//   `src/services/receivables.ts`  LOWERS it by the receipt amount when a customer
//                                  pays (this file). It NEVER raises it: nothing
//                                  about collecting money can increase a debt.
//
// No third module may write it. The two cannot collide on one sale, because a sale
// that has received money CANNOT BE VOIDED — enforced by the sale guard in migration
// 0020, and refused with a clean 409 by `saleVoidBlockedByReceipts` below. Without
// that rule the void would reverse the receivable while the receipt that settled it
// stood, leaving account 1100 holding a credit balance nothing explains.
// ===========================================================================

import type { PrismaClient as TenantPrismaClient } from "../generated/tenant/client";
import type { CustomerReceiptMethod } from "../generated/tenant/enums";
import { assertValidSchemaName, tenantSchemaFor } from "../db/tenant";
import type { Cents } from "../lib/money";
import { businessDateOf } from "../lib/business-time";
import { postJournalEntryWithinTransaction, type LedgerTx } from "./ledger";

/** Bad input (unknown customer, over-receipt, a non-credit sale). Route -> 400. */
export class ReceivablesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceivablesValidationError";
  }
}

/** The sale's or receipt's state forbids the operation. Route -> 409. */
export class ReceivablesStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceivablesStateError";
  }
}

const ACCT_AR = "1100";

/** Debit accounts by receipt method. Mirrors the payables credit map exactly. */
const RECEIPT_DEBIT_ACCOUNT: Record<CustomerReceiptMethod, string> = {
  CASH: "1000",
  BANK: "1020",
  MPESA: "1010",
};

function resolveSchema(db: TenantPrismaClient): string {
  const schema = tenantSchemaFor(db);
  assertValidSchemaName(schema);
  return schema;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface OpenCreditSaleRow {
  saleId: string;
  saleNumber: string;
  customerId: string;
  customerName: string;
  /** The business date the receivable arose: businessTimestamp for an offline sale. */
  saleDate: Date;
  /** The sale's full value, for context. NOT the receivable. */
  saleTotal: Cents;
  /** SUM of the sale's CREDIT tenders — the receivable this sale raised. */
  creditTotal: Cents;
  arReceived: Cents;
  /** `creditTotal - arReceived`. What is still owed on this sale. */
  outstanding: Cents;
  daysOutstanding: number;
}

export interface CustomerReceiptAllocationRow {
  id: string;
  saleId: string;
  saleNumber: string;
  amount: Cents;
}

export interface CustomerReceiptRow {
  id: string;
  receiptNumber: number;
  customerId: string;
  customerName: string;
  receiptDate: Date;
  method: CustomerReceiptMethod;
  amount: Cents;
  reference: string | null;
  notes: string | null;
  createdById: string;
  createdAt: Date;
  allocations: CustomerReceiptAllocationRow[];
}

const RECEIPT_INCLUDE = {
  customer: { select: { name: true } },
  allocations: {
    include: { sale: { select: { saleNumber: true } } },
    orderBy: { createdAt: "asc" },
  },
} as const;

interface RawReceipt {
  id: string;
  receiptNumber: number;
  customerId: string;
  receiptDate: Date;
  method: CustomerReceiptMethod;
  amount: bigint;
  reference: string | null;
  notes: string | null;
  createdById: string;
  createdAt: Date;
  customer: { name: string };
  allocations: Array<{
    id: string;
    saleId: string;
    amount: bigint;
    sale: { saleNumber: string };
  }>;
}

function toReceiptRow(receipt: RawReceipt): CustomerReceiptRow {
  return {
    id: receipt.id,
    receiptNumber: receipt.receiptNumber,
    customerId: receipt.customerId,
    customerName: receipt.customer.name,
    receiptDate: receipt.receiptDate,
    method: receipt.method,
    amount: receipt.amount,
    reference: receipt.reference,
    notes: receipt.notes,
    createdById: receipt.createdById,
    createdAt: receipt.createdAt,
    allocations: receipt.allocations.map((allocation) => ({
      id: allocation.id,
      saleId: allocation.saleId,
      saleNumber: allocation.sale.saleNumber,
      amount: allocation.amount,
    })),
  };
}

/**
 * THE SALE DATE THE RECEIVABLE AGES FROM.
 *
 * `businessTimestamp` when the sale came from an offline device — that is when it
 * actually happened and when the customer took the goods — and `createdAt`
 * otherwise, per the NULL-means-default rule (the engineering ledger: a NULL
 * `businessTimestamp` means an online sale, recorded as it happened). Ageing an
 * offline sale from its sync time would make a three-day-old debt look fresh.
 */
function saleDateOf(sale: { createdAt: Date; businessTimestamp: Date | null }): Date {
  return sale.businessTimestamp ?? sale.createdAt;
}

const MS_PER_DAY = 86_400_000;

/**
 * Whole BUSINESS days from one moment to another. Both ends are cut to their business
 * calendar day first (Task H.1), so a sale rung late at night is aged from the day it
 * belongs to, and an `asOf` date (00:00 UTC) compares as the day it names.
 */
function daysBetween(from: Date, to: Date): number {
  return Math.floor((businessDateOf(to).getTime() - businessDateOf(from).getTime()) / MS_PER_DAY);
}

/**
 * Whether a sale happened AFTER an explicitly requested `asOf` date. Compared as
 * business days: "as at 10 October" includes everything rung on 10 October, whereas
 * comparing the sale's instant with 00:00 UTC on the 10th dropped every sale made
 * during the very day the report was asked about.
 */
function isAfterCutoff(saleDate: Date, cutoff: Date): boolean {
  return businessDateOf(saleDate) > businessDateOf(cutoff);
}

// ---------------------------------------------------------------------------
// 1. OPEN CREDIT SALES — the list a receipt is allocated against
// ---------------------------------------------------------------------------

interface SaleWithTenders {
  id: string;
  saleNumber: string;
  customerId: string | null;
  total: bigint;
  arReceived: bigint;
  createdAt: Date;
  businessTimestamp: Date | null;
  customer: { id: string; name: string } | null;
  tenders: Array<{ tenderType: string; amount: bigint }>;
}

/** The receivable a sale raised: the sum of its CREDIT tenders, and nothing else. */
function creditTotalOf(sale: { tenders: Array<{ tenderType: string; amount: bigint }> }): Cents {
  let total = 0n;
  for (const tender of sale.tenders) {
    if (tender.tenderType === "CREDIT") {
      total += tender.amount;
    }
  }
  return total;
}

const OPEN_SALE_SELECT = {
  id: true,
  saleNumber: true,
  customerId: true,
  total: true,
  arReceived: true,
  createdAt: true,
  businessTimestamp: true,
  customer: { select: { id: true, name: true } },
  tenders: { select: { tenderType: true, amount: true } },
} as const;

function toOpenRow(sale: SaleWithTenders, asOf: Date, cutoff: Date | null): OpenCreditSaleRow | null {
  const creditTotal = creditTotalOf(sale);
  const outstanding = creditTotal - sale.arReceived;
  // A sale with no credit tender raised no receivable; one fully received is closed.
  if (creditTotal <= 0n || outstanding <= 0n || sale.customer === null) {
    return null;
  }
  const saleDate = saleDateOf(sale);
  // ONE CUTOFF RULE, SHARED BY EVERY AR READ — and it applies ONLY when the caller
  // asked for a specific date.
  //
  // WHY IT IS CONDITIONAL. A sale dated after an explicitly requested `asOf` had not
  // happened as at that date, so it is not a receivable as at that date; without the
  // cutoff a back-dated aging report would include sales that came later and would
  // disagree with the statement for the same customer, and the two reconciling is the
  // whole point of both.
  //
  // And "as at now" applies no cutoff at all: nothing can have happened after now,
  // so a cutoff there could only ever HIDE a receivable that `creditBalance` still
  // counts. (This was first written to defend against a timestamp-basis mismatch
  // between DB-default writes and the application clock; Task H.1 removed that
  // mismatch — every machine timestamp is now timestamptz in a UTC session — and the
  // rule stays because it is right on its own terms.)
  //
  // The comparison is between BUSINESS DAYS (Task H.1), so a sale made during the
  // named day is inside "as at" that day.
  if (cutoff !== null && isAfterCutoff(saleDate, cutoff)) {
    return null;
  }
  return {
    saleId: sale.id,
    saleNumber: sale.saleNumber,
    customerId: sale.customer.id,
    customerName: sale.customer.name,
    saleDate,
    saleTotal: sale.total,
    creditTotal,
    arReceived: sale.arReceived,
    outstanding,
    daysOutstanding: daysBetween(saleDate, asOf),
  };
}

/**
 * Every credit sale with something still owed on it, oldest first.
 *
 * Only COMPLETED sales appear: a VOIDED sale's receivable was reversed, so there is
 * nothing to collect — and because a sale with `arReceived > 0` cannot be voided,
 * the two rules close the loop from both ends.
 *
 * The filter on `arReceived` cannot be pushed into SQL, because the receivable it is
 * compared against is a SUM over another table rather than a column. Narrowing to
 * COMPLETED sales that have at least one CREDIT tender is what keeps the scan small,
 * and that part IS in the query.
 */
export async function listOpenCreditSales(
  db: TenantPrismaClient,
  filters: { customerId?: string; asOf?: Date } = {},
): Promise<OpenCreditSaleRow[]> {
  const asOf = filters.asOf ?? new Date();
  const cutoff = filters.asOf ?? null;
  const sales = await db.sale.findMany({
    where: {
      status: "COMPLETED",
      customerId: filters.customerId !== undefined ? filters.customerId : { not: null },
      tenders: { some: { tenderType: "CREDIT" } },
    },
    select: OPEN_SALE_SELECT,
    orderBy: { createdAt: "asc" },
  });
  const rows: OpenCreditSaleRow[] = [];
  for (const sale of sales) {
    const row = toOpenRow(sale, asOf, cutoff);
    if (row !== null) {
      rows.push(row);
    }
  }
  rows.sort((a, b) => a.saleDate.getTime() - b.saleDate.getTime());
  return rows;
}

// ---------------------------------------------------------------------------
// 2. THE VOID GUARD — the rule lives here, the refusal lives in sales.ts
// ---------------------------------------------------------------------------

/**
 * How much has been received against a sale, for the void path to refuse on.
 *
 * THE SEAM IS DELIBERATE, and it is the same one Task OFF.1 used for the
 * period-close guard: the RULE about receivables belongs to this module, while the
 * REFUSAL has to live in `voidSale` so that it holds for every caller rather than
 * only for the route that remembered to ask. `sales.ts` imports this function; this
 * module imports only the `LedgerTx` TYPE from the ledger, so there is no runtime
 * cycle.
 *
 * Migration 0020's sale guard enforces the same rule at the database, which is what
 * makes it a guarantee rather than ergonomics. This exists so the API returns a
 * message naming the amount instead of surfacing a trigger exception.
 */
export async function amountReceivedAgainstSale(
  tx: LedgerTx,
  saleId: string,
): Promise<Cents> {
  const sale = await tx.sale.findUnique({
    where: { id: saleId },
    select: { arReceived: true },
  });
  return sale?.arReceived ?? 0n;
}

/**
 * The message `voidSale` raises when a sale has already been collected against.
 * Written here, beside the rule, so the explanation and the rule cannot drift.
 */
export function saleVoidBlockedByReceipts(saleNumber: string, received: Cents): string {
  return (
    `Sale ${saleNumber} cannot be voided: ${received.toString()} cents have already been received ` +
    "against its credit balance. Voiding would reverse the receivable while the customer receipt that " +
    "settled it stands, leaving account 1100 Accounts Receivable with a credit balance that no document " +
    "explains. Refund the customer with a separate document instead."
  );
}

// ---------------------------------------------------------------------------
// 3. RECORD A RECEIPT
// ---------------------------------------------------------------------------

/**
 * Allocate the next receipt number from the tenant's own sequence.
 *
 * Schema-qualified, because the pg adapter does not set search_path (the engineering ledger
 * "Raw SQL and Tenant Schema Resolution"). Monotonic and unique, not gap-free — the
 * trade recorded in migration 0020(b).
 */
async function nextReceiptNumber(tx: LedgerTx, schema: string): Promise<number> {
  assertValidSchemaName(schema);
  const rows = await tx.$queryRawUnsafe<Array<{ v: bigint }>>(
    `SELECT nextval('"${schema}"."customer_receipt_number_seq"') AS v`,
  );
  const first = rows[0];
  if (first === undefined) {
    throw new Error("Failed to allocate a customer receipt number.");
  }
  return Number(first.v);
}

/**
 * Load a sale with its tenders under a ROW LOCK.
 *
 * The lock is what makes concurrent receipts against the same sale safe: two
 * payments allocated to one sale at the same instant serialise on the sale row, so
 * the second sees the first's `arReceived` and cannot over-collect against a stale
 * reading. The deferred `arReceived <= SUM(credit tenders)` constraint is the
 * backstop behind the lock.
 */
async function lockSale(
  tx: LedgerTx,
  schema: string,
  saleId: string,
): Promise<SaleWithTenders> {
  assertValidSchemaName(schema);
  const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT "id" FROM "${schema}".sales WHERE "id" = $1 FOR UPDATE`,
    saleId,
  );
  if (locked[0] === undefined) {
    throw new ReceivablesValidationError(`Unknown sale ${saleId}.`);
  }
  const sale = await tx.sale.findUnique({ where: { id: saleId }, select: OPEN_SALE_SELECT });
  if (sale === null) {
    throw new ReceivablesValidationError(`Unknown sale ${saleId}.`);
  }
  return sale;
}

export interface ReceiptAllocationInput {
  saleId: string;
  amount: Cents;
}

export interface RecordCustomerReceiptInput {
  customerId: string;
  receiptDate: Date;
  method: CustomerReceiptMethod;
  amount: Cents;
  reference?: string;
  notes?: string;
  allocations: ReceiptAllocationInput[];
  createdById: string;
}

/**
 * RECORD A RECEIPT FROM A CUSTOMER — ONE TRANSACTION, ALL OF IT.
 *
 *     Dr 1000 Cash | 1020 Bank | 1010 M-Pesa Till      the money that arrived
 *     Cr 1100 Accounts Receivable                      the debt it settles
 *
 * In the same transaction: each allocated sale's `arReceived` rises, and the
 * customer's `creditBalance` falls by the receipt amount. Either all of it commits
 * or none does — a receipt saved without its allocations would leave the subledger
 * overstated, and allocations without the entry would settle a debt no cash paid.
 *
 * NOTHING ABOUT REVENUE IS TOUCHED. The sale recognised its income and its output
 * VAT at the till; this is one asset becoming another.
 *
 * EVERY SHILLING MUST BE ALLOCATED, and the allocations must equal the receipt
 * exactly. There is no on-account customer balance in this build: an unallocated
 * receipt would be cash recorded as arriving with nobody's debt reduced, so the
 * subledger would stay overstated while the aging report kept chasing a customer who
 * had paid. The service refuses it with a clear message and migration 0020's DEFERRED
 * constraints refuse it at COMMIT — bound to BOTH the receipt and the allocations, so
 * a receipt with zero allocation rows is caught too (the lesson from 0019, applied
 * here up front).
 */
export async function recordCustomerReceipt(
  db: TenantPrismaClient,
  input: RecordCustomerReceiptInput,
): Promise<CustomerReceiptRow> {
  const schema = resolveSchema(db);

  if (input.amount <= 0n) {
    throw new ReceivablesValidationError("A receipt amount must be positive.");
  }
  if (input.allocations.length === 0) {
    throw new ReceivablesValidationError(
      "A receipt must be allocated to at least one credit sale: there is no on-account customer balance, so every shilling has to be pointed at a sale.",
    );
  }

  const allocationTotal = input.allocations.reduce((sum, a) => sum + a.amount, 0n);
  if (allocationTotal !== input.amount) {
    throw new ReceivablesValidationError(
      `The allocations total ${allocationTotal.toString()} cents but the receipt is ${input.amount.toString()} cents. Every shilling received must be allocated to a credit sale — an unallocated remainder would leave the customer's balance overstated and the aging report chasing someone who has paid.`,
    );
  }

  const seen = new Set<string>();
  for (const allocation of input.allocations) {
    if (allocation.amount <= 0n) {
      throw new ReceivablesValidationError("Every allocation amount must be positive.");
    }
    if (seen.has(allocation.saleId)) {
      throw new ReceivablesValidationError(
        `Sale ${allocation.saleId} appears twice in the allocations. Give one allocation per sale so that "how much of this receipt settled that sale" has a single answer.`,
      );
    }
    seen.add(allocation.saleId);
  }

  return db.$transaction(async (tx) => {
    const customer = await tx.customer.findUnique({
      where: { id: input.customerId },
      select: { id: true, name: true, isActive: true, creditBalance: true },
    });
    if (customer === null) {
      throw new ReceivablesValidationError(`Unknown customer ${input.customerId}.`);
    }

    // AN INACTIVE CUSTOMER MAY STILL PAY. Deactivation stops new credit being
    // given; refusing their settlement would strand the debt and the cash both.
    if (input.amount > customer.creditBalance) {
      throw new ReceivablesValidationError(
        `${customer.name} owes ${customer.creditBalance.toString()} cents but the receipt is ${input.amount.toString()} cents. A receipt may not exceed what is owed: a customer balance in their favour is a liability with its own rules and is deliberately out of scope.`,
      );
    }

    const receiptNumber = await nextReceiptNumber(tx, schema);
    const receipt = await tx.customerReceipt.create({
      data: {
        receiptNumber,
        customerId: customer.id,
        receiptDate: input.receiptDate,
        method: input.method,
        amount: input.amount,
        ...(input.reference !== undefined ? { reference: input.reference } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        createdById: input.createdById,
      },
    });

    // Deterministic order so two concurrent receipts touching the same pair of
    // sales take the row locks in the same sequence and cannot deadlock.
    const ordered = [...input.allocations].sort((a, b) => a.saleId.localeCompare(b.saleId));

    for (const allocation of ordered) {
      const sale = await lockSale(tx, schema, allocation.saleId);

      if (sale.customerId !== customer.id) {
        throw new ReceivablesValidationError(
          `Sale ${sale.saleNumber} belongs to a different customer. A receipt settles only the account of the customer who paid it.`,
        );
      }

      const creditTotal = creditTotalOf(sale);
      if (creditTotal <= 0n) {
        throw new ReceivablesValidationError(
          `Sale ${sale.saleNumber} has no CREDIT tender, so it raised no receivable and there is nothing to collect — it was settled at the till.`,
        );
      }

      const outstanding = creditTotal - sale.arReceived;
      if (outstanding <= 0n) {
        throw new ReceivablesStateError(
          `Sale ${sale.saleNumber} is already fully settled (${creditTotal.toString()} cents of ${creditTotal.toString()} received). Collecting against it again is the double-receipt this module exists to prevent.`,
        );
      }
      if (allocation.amount > outstanding) {
        throw new ReceivablesValidationError(
          `Allocating ${allocation.amount.toString()} cents to sale ${sale.saleNumber} would exceed its outstanding balance of ${outstanding.toString()} cents. A customer cannot pay more against a sale than it put on account.`,
        );
      }

      await tx.customerReceiptAllocation.create({
        data: { receiptId: receipt.id, saleId: sale.id, amount: allocation.amount },
      });
      await tx.sale.update({
        where: { id: sale.id },
        data: { arReceived: sale.arReceived + allocation.amount },
      });
    }

    // The customer's balance falls by the whole receipt, once. `creditBalance >= 0`
    // is CHECK-guaranteed since migration 0006, so the subtraction below cannot
    // produce a negative balance without the database refusing the write — and the
    // `amount > creditBalance` guard above returns the clean error first.
    await tx.customer.update({
      where: { id: customer.id },
      data: { creditBalance: customer.creditBalance - input.amount },
    });

    await postJournalEntryWithinTransaction(tx, schema, {
      entryDate: input.receiptDate,
      description: `Customer receipt RCT-${receiptNumber.toString()} — ${customer.name}`,
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
      source: "POS",
      sourceId: receipt.id,
      createdBy: input.createdById,
      lines: [
        {
          accountCode: RECEIPT_DEBIT_ACCOUNT[input.method],
          debit: input.amount,
          memo: `Received by ${input.method}`,
        },
        {
          accountCode: ACCT_AR,
          credit: input.amount,
          memo: `Settling ${customer.name}`,
        },
      ],
    });

    const created = await tx.customerReceipt.findUniqueOrThrow({
      where: { id: receipt.id },
      include: RECEIPT_INCLUDE,
    });
    return toReceiptRow(created);
  });
}

// ---------------------------------------------------------------------------
// 4. Reads — receipts
// ---------------------------------------------------------------------------

export interface ListCustomerReceiptFilters {
  customerId?: string;
  method?: CustomerReceiptMethod;
  from?: Date;
  to?: Date;
}

export async function listCustomerReceipts(
  db: TenantPrismaClient,
  filters: ListCustomerReceiptFilters = {},
): Promise<CustomerReceiptRow[]> {
  const receipts = await db.customerReceipt.findMany({
    where: {
      ...(filters.customerId !== undefined ? { customerId: filters.customerId } : {}),
      ...(filters.method !== undefined ? { method: filters.method } : {}),
      ...(filters.from !== undefined || filters.to !== undefined
        ? {
            receiptDate: {
              ...(filters.from !== undefined ? { gte: filters.from } : {}),
              ...(filters.to !== undefined ? { lte: filters.to } : {}),
            },
          }
        : {}),
    },
    include: RECEIPT_INCLUDE,
    orderBy: { receiptNumber: "desc" },
  });
  return receipts.map(toReceiptRow);
}

export interface CustomerReceiptDetail extends CustomerReceiptRow {
  /** The entry that posted this receipt. Derived from its own sourceId. */
  journalEntryId: string | null;
}

export async function getCustomerReceipt(
  db: TenantPrismaClient,
  id: string,
): Promise<CustomerReceiptDetail | null> {
  const receipt = await db.customerReceipt.findUnique({
    where: { id },
    include: RECEIPT_INCLUDE,
  });
  if (receipt === null) {
    return null;
  }
  // Derived rather than stored: the entry already carries `sourceId`, so a column
  // here would be a second copy of the same link that could fall out of step.
  const entry = await db.journalEntry.findFirst({
    where: { source: "POS", sourceId: receipt.id },
    select: { id: true },
    orderBy: { entryNumber: "asc" },
  });
  return { ...toReceiptRow(receipt), journalEntryId: entry?.id ?? null };
}

// ---------------------------------------------------------------------------
// 5. AR AGING
// ---------------------------------------------------------------------------

export interface AgingBuckets {
  current: Cents;
  days1To30: Cents;
  days31To60: Cents;
  days61To90: Cents;
  over90: Cents;
}

export interface CustomerAgingRow extends AgingBuckets {
  customerId: string;
  customerName: string;
  total: Cents;
  saleCount: number;
  oldestSaleDate: Date | null;
  /** The customer's own balance column, for comparison with `total`. */
  creditBalance: Cents;
  creditLimit: Cents;
}

export interface ArAgingReport {
  asOf: Date;
  customers: CustomerAgingRow[];
  totals: AgingBuckets;
  /**
   * The sum of every open credit sale's outstanding amount. **This equals
   * `SUM(Customer.creditBalance)`**, and both equal `GL(1100)` minus the
   * M-Pesa-failure residual — see the engineering ledger "Accounts Receivable".
   */
  grandTotal: Cents;
}

function emptyBuckets(): AgingBuckets {
  return { current: 0n, days1To30: 0n, days31To60: 0n, days61To90: 0n, over90: 0n };
}

/**
 * Add an outstanding amount to the bucket its age falls in.
 *
 * **AGED BY SALE DATE, NOT BY A DUE DATE**, and that is a scope decision rather than
 * an oversight: `Customer` carries no payment terms, so there is no due date to age
 * from and inventing one would bake a guess into live data. Day 0 is therefore
 * `current` and everything older is overdue by that many days. When customer payment
 * terms are added, this is the one function that changes — the buckets, the report
 * shape and the reconciliation all stay as they are.
 */
function addToBucket(buckets: AgingBuckets, days: number, amount: Cents): void {
  if (days <= 0) {
    buckets.current += amount;
  } else if (days <= 30) {
    buckets.days1To30 += amount;
  } else if (days <= 60) {
    buckets.days31To60 += amount;
  } else if (days <= 90) {
    buckets.days61To90 += amount;
  } else {
    buckets.over90 += amount;
  }
}

/**
 * ACCOUNTS RECEIVABLE AGING, bucketed by sale date over per-sale outstanding
 * amounts, grouped by customer.
 *
 * Built from the SAME derivation as the open-sales list — `SUM(credit tenders) -
 * arReceived` per COMPLETED sale — so the report and the allocation screen can never
 * disagree about what is owed. Each customer row also carries their
 * `creditBalance` column, because the two agreeing is the subledger invariant this
 * module is accountable for, and a report that shows both lets an owner see it hold.
 */
export async function getArAging(
  db: TenantPrismaClient,
  asOf?: Date,
): Promise<ArAgingReport> {
  // Pass the caller's INTENT through rather than a resolved default, so the cutoff
  // rule above can tell "as at this date" from "as at now". See `toOpenRow`.
  const open = await listOpenCreditSales(db, asOf !== undefined ? { asOf } : {});
  const reportedAsOf = asOf ?? new Date();
  const customerIds = [...new Set(open.map((row) => row.customerId))];
  const customers =
    customerIds.length === 0
      ? []
      : await db.customer.findMany({
          where: { id: { in: customerIds } },
          select: { id: true, creditBalance: true, creditLimit: true },
        });
  const balances = new Map(customers.map((c) => [c.id, c]));

  const byCustomer = new Map<string, CustomerAgingRow>();
  const totals = emptyBuckets();
  let grandTotal = 0n;

  for (const sale of open) {
    let row = byCustomer.get(sale.customerId);
    if (row === undefined) {
      const balance = balances.get(sale.customerId);
      row = {
        customerId: sale.customerId,
        customerName: sale.customerName,
        total: 0n,
        saleCount: 0,
        oldestSaleDate: null,
        creditBalance: balance?.creditBalance ?? 0n,
        creditLimit: balance?.creditLimit ?? 0n,
        ...emptyBuckets(),
      };
      byCustomer.set(sale.customerId, row);
    }
    addToBucket(row, sale.daysOutstanding, sale.outstanding);
    addToBucket(totals, sale.daysOutstanding, sale.outstanding);
    row.total += sale.outstanding;
    row.saleCount += 1;
    if (row.oldestSaleDate === null || sale.saleDate < row.oldestSaleDate) {
      row.oldestSaleDate = sale.saleDate;
    }
    grandTotal += sale.outstanding;
  }

  const rows = [...byCustomer.values()].sort((a, b) =>
    a.customerName.localeCompare(b.customerName),
  );
  return { asOf: reportedAsOf, customers: rows, totals, grandTotal };
}

// ---------------------------------------------------------------------------
// 6. CUSTOMER STATEMENT
// ---------------------------------------------------------------------------

export type StatementEntryKind = "CREDIT_SALE" | "RECEIPT";

export interface CustomerStatementEntry {
  kind: StatementEntryKind;
  date: Date;
  reference: string;
  description: string;
  /** What the credit sale added to what the customer owes. Zero on a receipt. */
  charged: Cents;
  /** What the receipt took off. Zero on a sale. */
  received: Cents;
  runningBalance: Cents;
}

export interface CustomerStatement {
  customerId: string;
  customerName: string;
  asOf: Date;
  entries: CustomerStatementEntry[];
  totalCharged: Cents;
  totalReceived: Cents;
  /**
   * `totalCharged - totalReceived`. It equals the customer's `creditBalance` column
   * and their slice of the aging report; the three agreeing is the subledger
   * invariant.
   */
  closingBalance: Cents;
  /** The live column, so a reader can see the statement tie to it. */
  creditBalance: Cents;
  creditLimit: Cents;
}

/**
 * A CUSTOMER STATEMENT: every credit sale and every receipt, in date order, with a
 * running balance.
 *
 * Only the CREDIT PORTION of each sale appears, not the sale total — a sale paid half
 * in cash and half on account put only the credit half on the customer's statement,
 * and charging the whole thing would make the closing balance disagree with
 * `creditBalance`.
 *
 * VOIDED sales are excluded: the void reversed both the receivable and the
 * `creditBalance`, so showing the charge without the reversal would break the tie-up —
 * and the whole value of a statement is that it reconciles. (A voided sale can never
 * carry a receipt, because a collected sale cannot be voided.)
 *
 * The running balance is accumulated in integer cents through the same BigInt
 * arithmetic as everything else; there is no floating point anywhere in it.
 */
export async function getCustomerStatement(
  db: TenantPrismaClient,
  customerId: string,
  asOfRequested?: Date,
): Promise<CustomerStatement | null> {
  const asOf = asOfRequested ?? new Date();
  // The SAME conditional cutoff `listOpenCreditSales` applies, for the same reason:
  // a statement as at a named date must not charge a sale that happened after it,
  // while "as at now" must never hide one the balance still counts.
  const cutoff = asOfRequested ?? null;
  const customer = await db.customer.findUnique({
    where: { id: customerId },
    select: { id: true, name: true, creditBalance: true, creditLimit: true },
  });
  if (customer === null) {
    return null;
  }

  const sales = await db.sale.findMany({
    where: { customerId, status: "COMPLETED", tenders: { some: { tenderType: "CREDIT" } } },
    select: {
      saleNumber: true,
      createdAt: true,
      businessTimestamp: true,
      tenders: { select: { tenderType: true, amount: true } },
    },
  });
  const receipts = await db.customerReceipt.findMany({
    where: {
      customerId,
      // A receipt's date is caller-supplied rather than clock-derived, so the cutoff
      // is safe to apply unconditionally here.
      ...(cutoff !== null ? { receiptDate: { lte: businessDateOf(cutoff) } } : {}),
    },
    select: {
      receiptNumber: true,
      receiptDate: true,
      amount: true,
      method: true,
      reference: true,
    },
  });

  const entries: CustomerStatementEntry[] = [];
  for (const sale of sales) {
    const creditTotal = creditTotalOf(sale);
    const date = saleDateOf(sale);
    if (creditTotal <= 0n || (cutoff !== null && isAfterCutoff(date, cutoff))) {
      continue;
    }
    entries.push({
      kind: "CREDIT_SALE",
      date,
      reference: sale.saleNumber,
      description: `Credit sale ${sale.saleNumber}`,
      charged: creditTotal,
      received: 0n,
      runningBalance: 0n,
    });
  }
  for (const receipt of receipts) {
    entries.push({
      kind: "RECEIPT",
      date: receipt.receiptDate,
      reference: receipt.reference ?? `RCT-${receipt.receiptNumber.toString()}`,
      description: `Receipt RCT-${receipt.receiptNumber.toString()} by ${receipt.method}`,
      charged: 0n,
      received: receipt.amount,
      runningBalance: 0n,
    });
  }

  // Date order, and within a date sales before receipts: the debt is incurred before
  // it is settled, so a same-day sale-and-payment pair reads correctly rather than
  // showing a transient negative balance.
  entries.sort((a, b) => {
    const byDate = a.date.getTime() - b.date.getTime();
    if (byDate !== 0) {
      return byDate;
    }
    if (a.kind !== b.kind) {
      return a.kind === "CREDIT_SALE" ? -1 : 1;
    }
    return a.reference.localeCompare(b.reference);
  });

  let running = 0n;
  let totalCharged = 0n;
  let totalReceived = 0n;
  for (const entry of entries) {
    running += entry.charged - entry.received;
    entry.runningBalance = running;
    totalCharged += entry.charged;
    totalReceived += entry.received;
  }

  return {
    customerId: customer.id,
    customerName: customer.name,
    asOf,
    entries,
    totalCharged,
    totalReceived,
    closingBalance: totalCharged - totalReceived,
    creditBalance: customer.creditBalance,
    creditLimit: customer.creditLimit,
  };
}
