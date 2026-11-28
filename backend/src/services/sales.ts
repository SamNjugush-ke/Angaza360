// ===========================================================================
// Point of Sale — sale transaction (Task 3.2).
//
// A sale is ONE db.$transaction that decrements stock, posts COGS per line, and
// posts the revenue side once — either all of it commits or none. This service
// writes ONLY sale/shift tables. It never writes journal or stock tables
// directly and never mutates product stock or an account balance: the cost leg
// goes through the inventory service (recordStockMovementWithinTransaction) and
// every GL posting goes through the ledger service (postJournalEntryWithin
// Transaction / reverseJournalEntryWithinTransaction). All three share the one
// transaction, so the whole sale is atomic.
//
// Design choice (as required): COGS entries are posted PER movement (per line)
// for auditability by the inventory service; the revenue entry is ONE per sale.
// The void does NOT re-reverse COGS — a SALE_RETURN movement is itself the cost
// leg's reversal (Dr 1200 / Cr 5000), so reversing the COGS entries as well
// would double-count.
//
// OFFLINE REPLAY (Task OFF.1). An offline sale is posted by THIS function, not by
// a second implementation: src/services/offline/sync.ts calls
// recordSaleWithinTransaction with the device's location as the selling location,
// the capture's businessTimestamp as the entry date, and the offline provenance
// block below. There is therefore exactly ONE sale-posting path in the system,
// under one set of database triggers, and an offline sale becomes a journal entry
// only on the server. The only things an offline replay changes are stated on
// OfflineSaleProvenance.
// ===========================================================================

import { randomUUID } from "node:crypto";
import type { PrismaClient as TenantPrismaClient } from "../generated/tenant/client";
import type {
  KraTaxCode,
  MpesaChannel,
  PaymentStatus,
  ProductType,
  SaleFiscalStatus,
  SaleOrigin,
  SalePaymentStatus,
  SaleStatus,
  TaxClass,
  TenderType,
} from "../generated/tenant/enums";
import { assertValidSchemaName, tenantSchemaFor } from "../db/tenant";
import { applyRatePercent, parseMoneyToCents, type Cents, formatCentsKes } from "../lib/money";
import { decimalToMilli, extendCost } from "../lib/inventory-math";
import { businessDateOf, businessDayStart } from "../lib/business-time";
import { appliedVatRate, effectiveLineTax, kraTaxCode } from "../lib/vat";
import { taxRegimeWithinTransaction, vatRegisteredFor } from "./business-profile";
import { likeLiteral } from "./catalog";
import { noVatRateMessage, resolveStandardVatRate, resolveTurnoverTaxRate } from "./tax-config";
import {
  postJournalEntryWithinTransaction,
  reverseJournalEntryWithinTransaction,
  type JournalLineInput,
  type LedgerTx,
} from "./ledger";
import { getSellableQuantitiesWithinTransaction, recordStockMovementWithinTransaction } from "./inventory";
// Task 6. The RULE about receivables belongs to the receivables module; the REFUSAL
// has to live in voidSale so it holds for every caller rather than only for the route
// that remembered to ask — the same seam Task OFF.1 used for the period-close guard.
// receivables.ts imports only the LedgerTx TYPE from the ledger, so there is no
// runtime cycle.
import {
  amountReceivedAgainstSale,
  saleVoidBlockedByReceipts,
} from "./receivables";
// Task 4.1. The void path RECORDS the fiscal obligation a voided signed sale
// creates; it never submits anything to KRA, so a refund never waits on a
// network. src/services/etims/etims-signing.ts remains the sole writer of the
// eTIMS tables and the sole flipper of fiscalStatus after a sale is created.
import { recordCreditNoteObligationWithinTransaction } from "./etims/etims-signing";

export class SaleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaleValidationError";
  }
}

export interface SaleLineInput {
  productId: string;
  quantity: string; // decimal string
  discount?: string; // decimal string (cents), per-line
}

export interface SaleTenderInput {
  tenderType: TenderType;
  amount: string; // decimal string in shillings
  mpesaReference?: string;
  // ---- PRE-CONFIRMED (online POS) tenders only (Task T-B-POS-PAY-B) — refused otherwise. ----
  /** CASH: the physical cash handed over (decimal string in shillings), at least the amount. */
  cashReceived?: string;
  /** MPESA: how the money came in. Defaults to STK for an STK-linked tender. */
  mpesaChannel?: MpesaChannel;
  /** MPESA: a CONFIRMED pre-sale STK push this tender consumes (POST /v1/pos/mpesa/stk-push). */
  mpesaCheckoutRequestId?: string;
}

/**
 * The provenance of a sale CAPTURED on an offline device and replayed here
 * (Task OFF.1). Supplied as ONE object so it cannot be half-filled — which is
 * also exactly what migration 0015's sale_offline_dimensions_complete CHECK
 * enforces at the database level.
 *
 * What its presence changes, and nothing else:
 *   * origin is recorded as OFFLINE_SYNCED and the four provenance columns are
 *     written, in this same transaction as the sale itself;
 *   * `createdBy` is taken from the SHIFT'S cashier rather than from the caller,
 *     because the person who rang the sale is not the person who synced it. It is
 *     still never client-supplied: it is read off the server's own shift row;
 *   * the shift-belongs-to-the-caller check is skipped for the same reason (the
 *     syncing user is a device operator, not necessarily the cashier).
 * Everything else — pricing, VAT, tender balance, credit limits, the stock
 * decrement, the location ownership check, the ledger postings — is identical.
 */
export interface OfflineSaleProvenance {
  /** When the sale ACTUALLY happened at the till. */
  businessTimestamp: Date;
  /** When the capture arrived at the server. Never conflated with the above. */
  syncedAt: Date;
  deviceId: string;
  idempotencyKey: string;
  /**
   * Set ONLY on the closed-period fallback: the true business date of a capture
   * whose own period had already closed, so the redirection is auditable.
   */
  originalBusinessDate?: Date;
}

export interface RecordSaleInput {
  shiftId: string;
  customerId?: string;
  lines: SaleLineInput[];
  tenders: SaleTenderInput[];
  createdBy: string;
  reference?: string;
  entryDate?: Date;
  /**
   * WHICH LOCATION IS SELLING (Task 3.2-LOC). Omitted means the tenant's MAIN
   * pool, so a caller that passes nothing behaves exactly as it did before this
   * existed. Every line's stock decrement is checked against, and taken from,
   * THIS location's owned quantity: a location sells only what it owns, so a
   * sale is refused when the selling location lacks the stock even though the
   * tenant holds plenty elsewhere.
   *
   * The location is recorded on the sale so a VOID returns the goods to the same
   * place they left from.
   */
  sellingLocationId?: string;
  /**
   * Present only for an offline replay. See OfflineSaleProvenance.
   */
  offline?: OfflineSaleProvenance;
  /**
   * "PRE_CONFIRMED" (Task T-B-POS-PAY-B): the online POS took every payment BEFORE posting —
   * an M-Pesa tender is already confirmed (a CALLBACK_OK pre-sale STK, or a manual reference),
   * so it posts to 1010 M-Pesa Till as CONFIRMED rather than to 1015 Clearing as PENDING, and
   * a cash tender may carry the cash received. Set ONLY by the POS sale route. Omitted, the sale
   * posts exactly as before this mode existed — the legacy post-first STK path and the offline
   * replay, byte for byte.
   */
  paymentMode?: "PRE_CONFIRMED";
  /**
   * Appended to the revenue journal entry's description. Used by the offline
   * closed-period fallback to carry the true business date onto the entry that
   * had to post into a later period, so the redirection is visible in the ledger
   * itself and not only on the sale row.
   */
  entryNote?: string;
  /**
   * THE PER-SALE eTIMS OPT-IN (Task 4.1). A cashier sets this when the customer
   * wants a KRA invoice — typically to claim the expense, which is why the buyer's
   * PIN usually accompanies it.
   *
   * It is OPTIONAL AND THE MINORITY CASE. Most MSME sales are informal, carry no
   * buyer PIN, and are never filed: omitting it leaves fiscalStatus NOT_REQUESTED
   * and the sale is validly finalized with no eTIMS involvement whatsoever. The
   * system never auto-submits every sale.
   *
   * All this flag does inside the sale transaction is RECORD THE REQUEST as
   * PENDING_ETIMS. The actual signing happens POST-COMMIT, outside this
   * transaction, so a KRA outage can never roll back a sale the customer has
   * already paid for.
   */
  requestEtims?: boolean;
}

export interface SaleLineResult {
  lineNumber: number;
  productId: string;
  sku: string;
  name: string;
  quantity: string;
  unitPrice: Cents;
  discount: Cents;
  /** The rate APPLIED to this line — "0.00" unless it was charged under code B. */
  vatRate: string;
  /** The product's tax class at sale time (STANDARD_RATED on a pre-3B.1 line). */
  taxClass: TaxClass;
  /** The KRA tax-type code the line was charged under (B on a pre-3B.1 line). */
  taxCode: KraTaxCode;
  lineNet: Cents;
  lineVat: Cents;
  lineTotal: Cents;
  unitCogs: Cents;
  /** The EXACT cost this line posted to the ledger; null on pre-3.1-FIX rows. */
  lineCogs: Cents | null;
}

export interface SaleTenderResult {
  id: string;
  tenderType: TenderType;
  amount: Cents;
  status: PaymentStatus;
  mpesaReference: string | null;
  mpesaTransactionId: string | null;
  /** How an MPESA tender's money came in (migration 0031); null when not recorded. */
  mpesaChannel: MpesaChannel | null;
  /** The physical cash handed over for a CASH tender (migration 0031); null when not recorded. */
  cashReceived: Cents | null;
}

export interface SaleResult {
  id: string;
  saleNumber: string;
  shiftId: string;
  customerId: string | null;
  status: SaleStatus;
  paymentStatus: SalePaymentStatus;
  subtotal: Cents;
  vatTotal: Cents;
  total: Cents;
  cogsTotal: Cents;
  saleJournalEntryId: string | null;
  /** Turnover Tax accrued on this sale (Task 3B.2); 0 unless the tenant is on TURNOVER_TAX. */
  totAccrued: Cents;
  voidedByEntryId: string | null;
  voidReason: string | null;
  reference: string | null;
  createdBy: string;
  createdAt: Date;
  /** The location the stock came from. NULL means MAIN (the pre-3.2-LOC default). */
  sellingLocationId: string | null;
  /** ONLINE, or OFFLINE_SYNCED for a sale captured on a device (Task OFF.1). */
  origin: SaleOrigin;
  /** When the sale actually happened. NULL on an online sale (it is createdAt). */
  businessTimestamp: Date | null;
  /** When the capture arrived. Never conflated with businessTimestamp. */
  syncedAt: Date | null;
  deviceId: string | null;
  idempotencyKey: string | null;
  /** Non-null ONLY when the closed-period fallback redirected this entry. */
  originalBusinessDate: Date | null;
  /** KRA fiscal state. NOT_REQUESTED for the ordinary unsigned sale (Task 4.1). */
  fiscalStatus: SaleFiscalStatus;
  lines: SaleLineResult[];
  tenders: SaleTenderResult[];
}

function resolveSchema(db: TenantPrismaClient): string {
  const schema = tenantSchemaFor(db);
  assertValidSchemaName(schema);
  return schema;
}

// Debit account for each tender type in the sale-time revenue entry.
//
// M-Pesa TIMING (Task 3.3, correcting 3.2): an MPESA tender is only PENDING at
// sale time — the money is not in yet — so it must NOT debit 1010 M-Pesa Till.
// It debits 1015 M-Pesa Clearing (an asset holding the promised STK amount). On
// a confirmed callback the payment service moves it 1015 -> 1010; on failure it
// reverses 1015. CASH/BANK_TRANSFER/CREDIT are real at sale time and debit
// their accounts directly, unchanged.
function tenderAccount(type: TenderType): string {
  switch (type) {
    case "CASH":
      return "1000";
    case "MPESA":
      return "1015"; // M-Pesa Clearing (STK Pending), NOT 1010 — money not yet received
    case "BANK_TRANSFER":
      return "1020";
    case "CREDIT":
      return "1100";
    default: {
      const exhaustive: never = type;
      throw new Error(`No revenue account for tender type ${String(exhaustive)}.`);
    }
  }
}

// MPESA tenders start PENDING (confirmed by 3.3's callback); everything else is
// confirmed at the till.
function tenderStatus(type: TenderType): PaymentStatus {
  return type === "MPESA" ? "PENDING" : "CONFIRMED";
}

// ---------------------------------------------------------------------------
// TENDERS, RESOLVED (Task T-B-POS-PAY-B). Each tender is resolved to the status it is stored
// with and the account its debit posts to — in ONE place, so the journal entry, the tender rows
// and the loyalty award cannot disagree.
// ---------------------------------------------------------------------------

/** M-Pesa money already received (a confirmed STK, or a manual Till / Paybill / STK reference). */
const ACCT_MPESA_TILL = "1010";

interface ResolvedTender {
  tenderType: TenderType;
  amount: Cents;
  status: PaymentStatus;
  account: string;
  mpesaReference: string | null;
  mpesaChannel: MpesaChannel | null;
  cashReceived: Cents | null;
  mpesaTransactionId: string | null;
}

/**
 * The LEGACY / OFFLINE tender: exactly what a sale posted before PAY-B — CASH, BANK_TRANSFER and
 * CREDIT confirmed to 1000 / 1020 / 1100, MPESA PENDING to 1015 Clearing for a later STK. The
 * pre-confirmed fields are refused here, never silently dropped.
 */
function legacyTender(tender: SaleTenderInput, amount: Cents, n: number): ResolvedTender {
  if (tender.cashReceived !== undefined || tender.mpesaChannel !== undefined || tender.mpesaCheckoutRequestId !== undefined) {
    throw new SaleValidationError(`Tender ${n}: cash received, an M-Pesa channel and an STK link are accepted only on a pre-confirmed online sale.`);
  }
  return {
    tenderType: tender.tenderType,
    amount,
    status: tenderStatus(tender.tenderType),
    account: tenderAccount(tender.tenderType),
    mpesaReference: tender.mpesaReference ?? null,
    mpesaChannel: null,
    cashReceived: null,
    mpesaTransactionId: null,
  };
}

/**
 * A PRE-CONFIRMED tender (the online POS, which takes payment BEFORE posting): every tender is
 * CONFIRMED. An M-Pesa tender posts to 1010 M-Pesa Till — the money is in — and must carry its
 * confirmation: a CALLBACK_OK pre-sale STK of exactly this amount, not yet used by any sale
 * (linked from the tender side), or a manual reference with its channel. A cash tender may carry
 * the cash handed over; only the AMOUNT is business money and posts to 1000 — the change is not.
 */
async function resolvePreConfirmedTender(tx: LedgerTx, tender: SaleTenderInput, amount: Cents, n: number): Promise<ResolvedTender> {
  const base = {
    tenderType: tender.tenderType,
    amount,
    status: "CONFIRMED" as const,
    mpesaReference: null,
    mpesaChannel: null,
    cashReceived: null,
    mpesaTransactionId: null,
  };
  if (tender.tenderType !== "CASH" && tender.cashReceived !== undefined) {
    throw new SaleValidationError(`Tender ${n}: cash received belongs only on a CASH tender.`);
  }
  if (
    tender.tenderType !== "MPESA" &&
    (tender.mpesaChannel !== undefined || tender.mpesaCheckoutRequestId !== undefined || tender.mpesaReference !== undefined)
  ) {
    throw new SaleValidationError(`Tender ${n}: an M-Pesa channel, reference or STK link belongs only on an MPESA tender.`);
  }

  if (tender.tenderType === "CASH") {
    const received = tender.cashReceived === undefined ? null : parseCents(tender.cashReceived, `tender ${n} cashReceived`);
    if (received !== null && received < amount) {
      throw new SaleValidationError(`Tender ${n}: the cash received is less than the amount this tender pays.`);
    }
    return { ...base, account: tenderAccount("CASH"), cashReceived: received };
  }

  if (tender.tenderType !== "MPESA") {
    return { ...base, account: tenderAccount(tender.tenderType) };
  }

  const checkout = tender.mpesaCheckoutRequestId?.trim();
  const reference = tender.mpesaReference?.trim();
  if (checkout && reference) {
    throw new SaleValidationError(`Tender ${n}: give either the STK checkout id or a manual M-Pesa reference, not both.`);
  }
  if (checkout) {
    const txn = await tx.mpesaTransaction.findUnique({ where: { checkoutRequestId: checkout } });
    if (txn === null) {
      throw new SaleValidationError(`Tender ${n}: there is no M-Pesa payment with that checkout id.`);
    }
    if (txn.saleId !== null || txn.tenderId !== null) {
      throw new SaleValidationError(`Tender ${n}: that M-Pesa push belongs to a sale already posted; it cannot pay another.`);
    }
    if (txn.status !== "CALLBACK_OK") {
      throw new SaleValidationError(`Tender ${n}: that M-Pesa payment has not been confirmed (it is ${txn.status}).`);
    }
    if (txn.amount !== amount) {
      throw new SaleValidationError(`Tender ${n}: the M-Pesa payment's amount does not match this tender.`);
    }
    if ((await tx.saleTender.findUnique({ where: { mpesaTransactionId: txn.id } })) !== null) {
      throw new SaleValidationError(`Tender ${n}: that M-Pesa payment has already been used for another sale.`);
    }
    if (tender.mpesaChannel !== undefined && tender.mpesaChannel !== "STK") {
      throw new SaleValidationError(`Tender ${n}: an STK-linked payment's channel is STK.`);
    }
    return { ...base, account: ACCT_MPESA_TILL, mpesaChannel: "STK", mpesaReference: txn.mpesaReceiptNumber, mpesaTransactionId: txn.id };
  }
  if (reference) {
    if (tender.mpesaChannel === undefined) {
      throw new SaleValidationError(`Tender ${n}: a manually confirmed M-Pesa payment needs its channel (STK, TILL or PAYBILL).`);
    }
    return { ...base, account: ACCT_MPESA_TILL, mpesaChannel: tender.mpesaChannel, mpesaReference: reference };
  }
  throw new SaleValidationError(
    `Tender ${n}: an M-Pesa payment needs its confirmation — the STK checkout id, or the M-Pesa reference from the customer's message with its channel.`,
  );
}

/** A concurrent second use of one pre-sale STK, caught by the unique index on the tender link. */
function isTenderLinkClash(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "P2002") return false;
  return JSON.stringify((error as { meta?: unknown }).meta ?? {}).includes("mpesaTransactionId");
}

/** The sale insert, with a race on one STK payment reported as the refusal it is. */
async function guardTenderLink<T>(write: PromiseLike<T>): Promise<T> {
  try {
    return await write;
  } catch (error) {
    if (isTenderLinkClash(error)) {
      throw new SaleValidationError("That M-Pesa payment has already been used for another sale.");
    }
    throw error;
  }
}

// 1 loyalty point per whole KES 100 (10000 cents) of CONFIRMED tender value.
function loyaltyPointsFor(confirmedTotal: Cents): number {
  return Number(confirmedTotal / 10_000n);
}

// The sale number carries the BUSINESS day the sale belongs to — the same day its
// journal entry is dated to — so SALE-20261101-… is never an October entry.
function saleDayParts(instant: Date): { dayIso: string; yyyymmdd: string } {
  const date = businessDateOf(instant);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return { dayIso: `${year}-${month}-${day}`, yyyymmdd: `${year}${month}${day}` };
}

// Atomically allocate the next per-day sale number. The upsert row-locks the day
// row, so concurrent sales never collide.
async function nextSaleNumber(tx: LedgerTx, schema: string, date: Date): Promise<string> {
  const { dayIso, yyyymmdd } = saleDayParts(date);
  const rows = await tx.$queryRawUnsafe<Array<{ counter: number }>>(
    `INSERT INTO "${schema}"."sale_number_counters" ("day", "counter") VALUES ($1::date, 1)
     ON CONFLICT ("day") DO UPDATE SET "counter" = "sale_number_counters"."counter" + 1
     RETURNING "counter"`,
    dayIso,
  );
  const counter = rows[0]?.counter ?? 1;
  return `SALE-${yyyymmdd}-${String(counter).padStart(6, "0")}`;
}

interface RawSale {
  id: string;
  saleNumber: string;
  shiftId: string;
  customerId: string | null;
  status: SaleStatus;
  paymentStatus: SalePaymentStatus;
  subtotal: bigint;
  vatTotal: bigint;
  total: bigint;
  cogsTotal: bigint;
  saleJournalEntryId: string | null;
  totAccrued: bigint;
  voidedByEntryId: string | null;
  voidReason: string | null;
  reference: string | null;
  createdBy: string;
  createdAt: Date;
  sellingLocationId: string | null;
  origin: SaleOrigin;
  businessTimestamp: Date | null;
  syncedAt: Date | null;
  deviceId: string | null;
  idempotencyKey: string | null;
  originalBusinessDate: Date | null;
  fiscalStatus: SaleFiscalStatus;
  lines: Array<{
    lineNumber: number;
    productId: string;
    quantity: { toString(): string };
    unitPrice: bigint;
    discount: bigint;
    vatRate: { toString(): string };
    lineNet: bigint;
    lineVat: bigint;
    lineTotal: bigint;
    unitCogs: bigint;
    lineCogs: bigint | null;
    taxClass: TaxClass | null;
    taxCode: KraTaxCode | null;
    product: { sku: string; name: string };
  }>;
  tenders: Array<{
    id: string;
    tenderType: TenderType;
    amount: bigint;
    status: PaymentStatus;
    mpesaReference: string | null;
    mpesaTransactionId: string | null;
    mpesaChannel: MpesaChannel | null;
    cashReceived: bigint | null;
  }>;
}

function mapSale(sale: RawSale): SaleResult {
  return {
    id: sale.id,
    saleNumber: sale.saleNumber,
    shiftId: sale.shiftId,
    customerId: sale.customerId,
    status: sale.status,
    paymentStatus: sale.paymentStatus,
    subtotal: sale.subtotal,
    vatTotal: sale.vatTotal,
    total: sale.total,
    cogsTotal: sale.cogsTotal,
    saleJournalEntryId: sale.saleJournalEntryId,
    totAccrued: sale.totAccrued,
    voidedByEntryId: sale.voidedByEntryId,
    voidReason: sale.voidReason,
    reference: sale.reference,
    createdBy: sale.createdBy,
    createdAt: sale.createdAt,
    sellingLocationId: sale.sellingLocationId,
    origin: sale.origin,
    businessTimestamp: sale.businessTimestamp,
    syncedAt: sale.syncedAt,
    deviceId: sale.deviceId,
    idempotencyKey: sale.idempotencyKey,
    originalBusinessDate: sale.originalBusinessDate,
    fiscalStatus: sale.fiscalStatus,
    lines: [...sale.lines]
      .sort((a, b) => a.lineNumber - b.lineNumber)
      .map((line) => ({
        lineNumber: line.lineNumber,
        productId: line.productId,
        sku: line.product.sku,
        name: line.product.name,
        quantity: line.quantity.toString(),
        unitPrice: line.unitPrice,
        discount: line.discount,
        vatRate: line.vatRate.toString(),
        ...effectiveLineTax(line),
        lineNet: line.lineNet,
        lineVat: line.lineVat,
        lineTotal: line.lineTotal,
        unitCogs: line.unitCogs,
        lineCogs: line.lineCogs,
      })),
    tenders: sale.tenders.map((tender) => ({
      id: tender.id,
      tenderType: tender.tenderType,
      amount: tender.amount,
      status: tender.status,
      mpesaReference: tender.mpesaReference,
      mpesaTransactionId: tender.mpesaTransactionId,
      mpesaChannel: tender.mpesaChannel,
      cashReceived: tender.cashReceived,
    })),
  };
}

const SALE_INCLUDE = {
  lines: { include: { product: { select: { sku: true, name: true } } } },
  tenders: true,
} as const;

function validateSaleShape(input: RecordSaleInput): void {
  if (input.lines.length === 0) {
    throw new SaleValidationError("A sale needs at least one line.");
  }
  if (input.tenders.length === 0) {
    throw new SaleValidationError("A sale needs at least one tender.");
  }
}

export async function recordSale(
  db: TenantPrismaClient,
  input: RecordSaleInput,
): Promise<SaleResult> {
  const schema = resolveSchema(db);
  validateSaleShape(input);
  return db.$transaction((tx) => recordSaleCore(tx, schema, input));
}

/**
 * Record a sale INSIDE a transaction the caller already opened, so the sale and
 * the caller's own row commit atomically.
 *
 * This exists for the OFFLINE SYNC INGEST (Task OFF.1): a captured sale and the
 * captured_sales row that records its arrival must land together, or a sale could
 * exist with no ingest record (or a record with no sale). It is the same pattern
 * as recordStockMovementWithinTransaction and transferStockWithinTransaction, and
 * it exists precisely SO THAT sync does not need a second sale-posting path:
 * src/services/sales.ts remains the sole writer of the sale tables, and this
 * function is the only implementation of "post a sale" in the system.
 *
 * The caller passes the resolved, validated tenant schema and owns the
 * transaction and its error translation.
 */
export async function recordSaleWithinTransaction(
  tx: LedgerTx,
  schema: string,
  input: RecordSaleInput,
): Promise<SaleResult> {
  assertValidSchemaName(schema);
  validateSaleShape(input);
  return recordSaleCore(tx, schema, input);
}

// ===========================================================================
// PRICING A SALE (extracted for Task T-B-POS-QUOTE). The ONE implementation of a sale's
// money: each line priced from the product snapshot, its KRA tax code from the class and the
// tenant's regime, VAT at the standard rate in force on the sale's business date (code B
// only), and the totals. recordSaleCore posts what it returns; quoteSale returns it to the till
// before any payment is taken. Neither re-derives a figure, so a quote can never disagree with
// the sale it precedes. It READS ONLY (products, the regime, the dated rate) and writes nothing.
// ===========================================================================

export interface PricedSaleLine {
  lineNumber: number;
  productId: string;
  sku: string;
  name: string;
  quantityStr: string;
  unitPrice: Cents;
  discount: Cents;
  vatRate: string;
  taxClass: TaxClass;
  taxCode: KraTaxCode;
  lineNet: Cents;
  lineVat: Cents;
  lineTotal: Cents;
  /** GOOD lines move stock and post COGS; SERVICE lines do neither (Task T-A8). */
  kind: ProductType;
}

export interface PricedSale {
  lines: PricedSaleLine[];
  subtotal: Cents;
  vatTotal: Cents;
  total: Cents;
  taxRegime: Awaited<ReturnType<typeof taxRegimeWithinTransaction>>;
}

export async function priceSaleLines(tx: LedgerTx, lines: readonly SaleLineInput[], saleDate: Date): Promise<PricedSale> {
  const computed: PricedSaleLine[] = [];
  let subtotal = 0n;
  let vatTotal = 0n;
  let lineNumber = 0;
  // THE VAT RULE (Task 3B.1). Output VAT applies ONLY when the tenant is
  // VAT-registered AND the line is standard-rated; every line of a non-registered
  // tenant is code D and charges nothing, whatever the product's class. The regime
  // is read once per sale. The standard RATE is configuration — the effective
  // StatutorySchedule for the sale's business date — resolved only when a B line
  // actually needs it, and a date no schedule covers is REFUSED rather than priced
  // on a rate that was not in force.
  const taxRegime = await taxRegimeWithinTransaction(tx);
  const isVatRegistered = vatRegisteredFor(taxRegime);
  let standardRate: string | null = null;
  for (const line of lines) {
    lineNumber += 1;
    const product = await tx.product.findUnique({ where: { id: line.productId } });
    if (product === null) {
      throw new SaleValidationError(`Line ${lineNumber}: unknown product ${line.productId}.`);
    }
    if (!product.isActive) {
      throw new SaleValidationError(`Line ${lineNumber}: product ${product.sku} is inactive.`);
    }
    const qtyMilli = decimalToMilli(line.quantity);
    if (qtyMilli <= 0n) {
      throw new SaleValidationError(`Line ${lineNumber}: quantity must be positive.`);
    }
    const discount = line.discount === undefined ? 0n : parseCents(line.discount, `line ${lineNumber} discount`);
    if (discount < 0n) {
      throw new SaleValidationError(`Line ${lineNumber}: discount must not be negative.`);
    }
    const gross = extendCost(qtyMilli, product.price);
    const lineNet = gross - discount;
    if (lineNet < 0n) {
      throw new SaleValidationError(`Line ${lineNumber}: discount exceeds the line value.`);
    }
    const taxCode = kraTaxCode(product.taxClass, isVatRegistered);
    if (taxCode === "B" && standardRate === null) {
      const resolved = await resolveStandardVatRate(tx, saleDate);
      if (resolved === null) {
        throw new SaleValidationError(noVatRateMessage(saleDate));
      }
      standardRate = resolved.rate;
    }
    const vatRate = appliedVatRate(taxCode, standardRate ?? "0.00");
    const lineVat = taxCode === "B" ? applyRatePercent(lineNet, vatRate) : 0n;
    const lineTotal = lineNet + lineVat;
    subtotal += lineNet;
    vatTotal += lineVat;
    computed.push({
      lineNumber,
      productId: product.id,
      sku: product.sku,
      name: product.name,
      quantityStr: line.quantity,
      unitPrice: product.price,
      discount,
      vatRate,
      taxClass: product.taxClass,
      taxCode,
      lineNet,
      lineVat,
      lineTotal,
      kind: product.kind,
    });
  }
  return { lines: computed, subtotal, vatTotal, total: subtotal + vatTotal, taxRegime };
}

// ===========================================================================
// THE PRE-SALE QUOTE (Task T-B-POS-QUOTE). The till needs the exact total — VAT included —
// before it takes payment, because tenders must equal it to the cent. The quote prices the
// lines through priceSaleLines, the SAME function the sale posts with, inside a READ ONLY
// transaction: PostgreSQL itself refuses any write, so a quote can change nothing. For each
// GOOD line it adds what the resolved selling location may sell — a warning, not a reservation.
// ===========================================================================

export interface SaleQuoteInput {
  lines: SaleLineInput[];
  customerId?: string;
  sellingLocationId?: string;
}

export interface SaleQuote extends PricedSale {
  sellingLocationId: string;
  /** Sellable quantity per GOOD line's product at that location (decimal strings). */
  sellable: Map<string, string>;
}

export async function quoteSale(db: TenantPrismaClient, input: SaleQuoteInput, saleDate: Date = new Date()): Promise<SaleQuote> {
  const schema = resolveSchema(db);
  if (input.lines.length === 0) {
    throw new SaleValidationError("A sale needs at least one line.");
  }
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    const priced = await priceSaleLines(tx, input.lines, saleDate);
    if (input.customerId !== undefined) {
      const customer = await tx.customer.findUnique({ where: { id: input.customerId } });
      if (customer === null) throw new SaleValidationError(`Unknown customer ${input.customerId}.`);
      if (!customer.isActive) throw new SaleValidationError("Customer is inactive.");
    }
    const sellingLocationId = await resolveSellingLocation(tx, input.sellingLocationId, "sale");
    const goods = [...new Set(priced.lines.filter((line) => line.kind === "GOOD").map((line) => line.productId))];
    const sellable = await getSellableQuantitiesWithinTransaction(tx, schema, sellingLocationId, goods);
    return { ...priced, sellingLocationId, sellable };
  });
}

async function recordSaleCore(
  tx: LedgerTx,
  schema: string,
  input: RecordSaleInput,
): Promise<SaleResult> {
  const saleDate = input.entryDate ?? new Date();

  // Who the sale is ATTRIBUTED to. Resolved from the shift below, because an
  // offline replay was rung by the device's cashier and delivered by whoever
  // synced the batch.
  let createdBy: string;

  {
    // 1. Shift must exist and be OPEN.
    //
    // An ONLINE sale must additionally belong to the cashier making it. An
    // OFFLINE REPLAY does not: the sale was rung by the device's cashier and is
    // being delivered by whoever synced the batch, so the sale is attributed to
    // the SHIFT'S cashier — read off the server's own shift row, never from the
    // request — and the ownership check would be comparing the wrong two people.
    //
    // The shift must still be OPEN for a replay, and that is deliberate: a closed
    // shift carries a COUNTED cash variance, signed off by the cashier. Posting a
    // cash sale into it afterwards would silently falsify that figure. A capture
    // whose shift has closed is therefore routed to the NEEDS_RESOLUTION queue by
    // the sync service — never dropped, never posted into a settled reconciliation.
    const shift = await tx.shift.findUnique({ where: { id: input.shiftId } });
    if (shift === null) {
      throw new SaleValidationError(`Shift ${input.shiftId} not found.`);
    }
    if (shift.status !== "OPEN") {
      throw new SaleValidationError(
        input.offline === undefined
          ? "Shift is not open."
          : `Shift ${input.shiftId} is CLOSED. A captured sale cannot post into a closed shift: its counted cash variance was already signed off, and a late cash sale would falsify it.`,
      );
    }
    if (input.offline === undefined && shift.cashierId !== input.createdBy) {
      throw new SaleValidationError("Shift belongs to another cashier.");
    }
    // Server-derived, so an offline replay is attributed to whoever actually rang
    // it while remaining impossible for a caller to spoof.
    createdBy = input.offline === undefined ? input.createdBy : shift.cashierId;

    // 1b. Resolve the SELLING LOCATION (Task 3.2-LOC). Resolved once for the
    // whole sale, inside the transaction, so every line draws from the same
    // place and the location cannot change mid-sale. Omitted resolves to the
    // tenant's MAIN pool, which is precisely what the inventory service did
    // implicitly before this parameter existed — so a caller that passes
    // nothing gets the pre-existing behaviour, byte for byte.
    const sellingLocationId = await resolveSellingLocation(tx, input.sellingLocationId, "sale");

    // 2. Price each line — THE shared pricing path (Task T-B-POS-QUOTE): the pre-sale quote
    // calls the very same function, so a quoted total IS the posted total by construction.
    const priced = await priceSaleLines(tx, input.lines, saleDate);
    const computed = priced.lines;
    const { subtotal, vatTotal, total, taxRegime } = priced;

    // 3. Tenders must sum to the total EXACTLY.
    let tenderSum = 0n;
    let creditAmount = 0n;
    const parsedTenders: ResolvedTender[] = [];
    for (const [index, tender] of input.tenders.entries()) {
      const amount = parseCents(tender.amount, `tender ${index + 1} amount`);
      if (amount <= 0n) {
        throw new SaleValidationError(`Tender ${index + 1}: amount must be positive.`);
      }
      tenderSum += amount;
      if (tender.tenderType === "CREDIT") {
        creditAmount += amount;
      }
      parsedTenders.push(
        input.paymentMode === "PRE_CONFIRMED"
          ? await resolvePreConfirmedTender(tx, tender, amount, index + 1)
          : legacyTender(tender, amount, index + 1),
      );
    }
    if (tenderSum !== total) {
      throw new SaleValidationError(
        `Tenders total ${formatCentsKes(tenderSum)} but the sale total is ${formatCentsKes(total)}.`,
      );
    }

    // 4. Customer and credit checks.
    let customer = null;
    if (input.customerId !== undefined) {
      customer = await tx.customer.findUnique({ where: { id: input.customerId } });
      if (customer === null) {
        throw new SaleValidationError(`Unknown customer ${input.customerId}.`);
      }
      if (!customer.isActive) {
        throw new SaleValidationError("Customer is inactive.");
      }
    }
    if (creditAmount > 0n) {
      if (customer === null) {
        throw new SaleValidationError("A CREDIT tender requires a customer.");
      }
      const remaining = customer.creditLimit - customer.creditBalance;
      if (creditAmount > remaining) {
        throw new SaleValidationError(
          `Credit of ${formatCentsKes(creditAmount)} exceeds the customer's remaining credit of ${formatCentsKes(remaining)}.`,
        );
      }
    }

    // 5. Decrement stock per line via the inventory service; this posts the COGS
    // side (Dr 5000 / Cr 1200) per line. Insufficient stock aborts the sale.
    //
    // The movement is stamped with the SELLING LOCATION, so the inventory
    // service checks availability against what THAT location OWNS — not the
    // tenant-wide aggregate — and decrements that location's slice. A till
    // holding 5 cannot sell 6 even when the warehouse holds 500. Valuation is
    // untouched by this: COGS still comes from the aggregate Product.stockValue
    // and the depletion rule still keys on the AGGREGATE reaching zero, so a
    // location running dry while the tenant still holds stock is an ordinary
    // partial movement.
    //
    // A SERVICE LINE (Task T-A8) HAS NO COST SIDE: no stock movement, no COGS, no touch
    // of 1200, and its COGS snapshot is exactly 0. It still contributes, like any line,
    // to the subtotal (revenue and the TOT turnover) and to output VAT by its tax class.
    let cogsTotal = 0n;
    const unitCogsByLine = new Map<number, Cents>();
    const lineCogsByLine = new Map<number, Cents>();
    for (const line of computed) {
      if (line.kind === "SERVICE") {
        unitCogsByLine.set(line.lineNumber, 0n);
        lineCogsByLine.set(line.lineNumber, 0n);
        continue;
      }
      const movement = await recordStockMovementWithinTransaction(tx, schema, {
        productId: line.productId,
        movementType: "SALE",
        quantity: line.quantityStr,
        createdBy,
        entryDate: saleDate,
        reference: input.reference,
        locationId: sellingLocationId,
      });
      // movement.totalCost is THE valuation event for this line — the same
      // figure that moved Product.stockValue and credited account 1200. It is
      // snapshotted on the sale line so a void can reverse exactly it, rather
      // than re-extending the rounded per-unit figure and leaving 1200 a cent
      // or two off (Task 3.1-FIX).
      unitCogsByLine.set(line.lineNumber, movement.unitCost);
      lineCogsByLine.set(line.lineNumber, movement.totalCost);
      cogsTotal += movement.totalCost;
    }

    // 6. Allocate id + number, then post the ONE revenue-side entry (sourceId =
    // sale id) so we can store its id on the sale at insert time (the sale guard
    // trigger forbids editing the sale afterwards).
    const saleId = randomUUID();
    const saleNumber = await nextSaleNumber(tx, schema, saleDate);

    const debitByAccount = new Map<string, Cents>();
    for (const tender of parsedTenders) {
      debitByAccount.set(tender.account, (debitByAccount.get(tender.account) ?? 0n) + tender.amount);
    }
    const revenueLines: JournalLineInput[] = [];
    for (const [account, amount] of debitByAccount) {
      revenueLines.push({ accountCode: account, debit: amount });
    }
    if (subtotal > 0n) {
      revenueLines.push({ accountCode: "4000", credit: subtotal });
    }
    if (vatTotal > 0n) {
      revenueLines.push({ accountCode: "2100", credit: vatTotal });
    }

    // TURNOVER TAX (Task 3B.2). A TURNOVER_TAX tenant pays a final tax on gross
    // turnover INSTEAD of VAT, so it accrues here — rate x turnover, rounded once
    // through the single primitive — as ONE extra balanced pair INSIDE this same
    // revenue entry:   Dr 6110 Turnover Tax / Cr 2110 TOT Payable.
    //
    // WHAT IT NEVER DOES: it is a tax on the BUSINESS, not charged to the customer, so
    // it changes nothing the customer pays and never appears on the receipt; and it
    // touches no revenue, VAT, stock or 1200 line. Turnover is the subtotal — for a TOT
    // tenant there is no VAT (3B.1), so that is the whole sale.
    //
    // WHY INSIDE THE REVENUE ENTRY: a void reverses that entry as an exact mirror, so
    // the accrual it takes back is precisely what was posted — never a re-computation
    // at whatever rate is in force on the day of the void. `Sale.totAccrued` stores the
    // same figure, and the void asserts the two agree before reversing.
    let totAccrued = 0n;
    if (taxRegime === "TURNOVER_TAX" && subtotal > 0n) {
      const totRate = await resolveTurnoverTaxRate(tx, saleDate);
      if (totRate === null) {
        throw new SaleValidationError(noVatRateMessage(saleDate));
      }
      totAccrued = applyRatePercent(subtotal, totRate.rate);
      if (totAccrued > 0n) {
        revenueLines.push({
          accountCode: "6110",
          debit: totAccrued,
          memo: `Turnover Tax ${totRate.rate}% on turnover`,
        });
        revenueLines.push({ accountCode: "2110", credit: totAccrued, memo: "TOT payable" });
      }
    }
    const revenueEntry = await postJournalEntryWithinTransaction(tx, schema, {
      entryDate: saleDate,
      description:
        input.entryNote === undefined
          ? `Sale ${saleNumber}`
          : `Sale ${saleNumber} (${input.entryNote})`,
      reference: input.reference,
      source: "POS",
      sourceId: saleId,
      createdBy,
      lines: revenueLines,
    });

    // Insert the sale with lines and tenders in one write.
    await guardTenderLink(tx.sale.create({
      data: {
        id: saleId,
        saleNumber,
        shiftId: input.shiftId,
        customerId: input.customerId ?? null,
        subtotal,
        vatTotal,
        total,
        cogsTotal,
        saleJournalEntryId: revenueEntry.id,
        totAccrued,
        reference: input.reference ?? null,
        createdBy,
        sellingLocationId,
        // OFFLINE PROVENANCE (Task OFF.1), written in the SAME insert as the
        // sale. There is no arrival-then-update step, which is why migration
        // 0015's guard freezes all six columns with no permitted transition.
        origin: input.offline === undefined ? "ONLINE" : "OFFLINE_SYNCED",
        businessTimestamp: input.offline?.businessTimestamp ?? null,
        syncedAt: input.offline?.syncedAt ?? null,
        deviceId: input.offline?.deviceId ?? null,
        idempotencyKey: input.offline?.idempotencyKey ?? null,
        originalBusinessDate: input.offline?.originalBusinessDate ?? null,
        // Task 4.1: record the REQUEST only. Signing is post-commit, and the
        // overwhelmingly common case is that nothing was requested at all.
        fiscalStatus: input.requestEtims === true ? "PENDING_ETIMS" : "NOT_REQUESTED",
        lines: {
          create: computed.map((line) => {
            const unitCogs = unitCogsByLine.get(line.lineNumber);
            const lineCogs = lineCogsByLine.get(line.lineNumber);
            if (unitCogs === undefined || lineCogs === undefined) {
              throw new Error(`Missing COGS for line ${line.lineNumber}.`);
            }
            return {
              lineNumber: line.lineNumber,
              productId: line.productId,
              quantity: line.quantityStr,
              unitPrice: line.unitPrice,
              discount: line.discount,
              vatRate: line.vatRate,
              taxClass: line.taxClass,
              taxCode: line.taxCode,
              lineNet: line.lineNet,
              lineVat: line.lineVat,
              lineTotal: line.lineTotal,
              unitCogs,
              lineCogs,
            };
          }),
        },
        tenders: {
          create: parsedTenders.map((tender) => ({
            tenderType: tender.tenderType,
            amount: tender.amount,
            status: tender.status,
            mpesaReference: tender.mpesaReference,
            mpesaChannel: tender.mpesaChannel,
            cashReceived: tender.cashReceived,
            // THE TENDER-SIDE LINK (Task T-B-POS-PAY-B): a pre-sale STK is attached to the sale by
            // the TENDER pointing at it. mpesa_transactions.saleId is frozen and a terminal row
            // cannot change, so the transaction is never written; the unique index on
            // sale_tenders.mpesaTransactionId is what stops one payment settling two sales.
            mpesaTransactionId: tender.mpesaTransactionId,
          })),
        },
      },
    }));

    // 7. Customer effects: raise creditBalance by the CREDIT portion, award
    // loyalty on CONFIRMED tender value only.
    if (customer !== null) {
      let confirmedTotal = 0n;
      for (const tender of parsedTenders) {
        if (tender.status === "CONFIRMED") {
          confirmedTotal += tender.amount;
        }
      }
      const points = loyaltyPointsFor(confirmedTotal);
      await tx.customer.update({
        where: { id: customer.id },
        data: {
          creditBalance: customer.creditBalance + creditAmount,
          loyaltyPoints: customer.loyaltyPoints + points,
        },
      });
    }

    const created = await tx.sale.findUniqueOrThrow({
      where: { id: saleId },
      include: SALE_INCLUDE,
    });
    return mapSale(created);
  }
}

/**
 * What a void produced. The sale, plus — for the rare voided sale that HAD been
 * filed with KRA — the credit-note obligation the void created (Task 4.1).
 *
 * `creditNote` is null for the overwhelmingly common void, because the sale was
 * never fiscally signed and so owes KRA nothing.
 */
export interface VoidSaleResult {
  sale: SaleResult;
  creditNote: { invoiceId: string; etimsInvoiceNumber: number } | null;
}

export interface VoidSaleOptions {
  /**
   * The shift whose drawer pays the cash refund (Task T-B-SHIFT-VOID). Omitted: the sale's own
   * shift while it is still open, else the voiding user's own open shift. It must be OPEN.
   */
  shiftId?: string;
}

/**
 * WHICH DRAWER PAYS A VOID'S CASH REFUND (Task T-B-SHIFT-VOID). A shift's expected cash counts
 * the cash it took and the cash it paid out, so a refund has to be booked against the till it
 * actually left: the shift named, else the sale's own shift if it is still open (a same-shift
 * void), else the voider's own open shift. A sale that took no cash refunds no cash and needs
 * no drawer. A cash sale with nowhere to refund from is REFUSED rather than guessed: booking it
 * against a closed shift would falsify that shift's settled count.
 */
async function resolveVoidShift(
  tx: LedgerTx,
  sale: { saleNumber: string; shiftId: string; tenders: ReadonlyArray<{ tenderType: string; status: string; amount: bigint }> },
  userId: string,
  requested: string | undefined,
): Promise<string | null> {
  if (requested !== undefined) {
    const shift = await tx.shift.findUnique({ where: { id: requested }, select: { status: true } });
    if (shift === null) throw new SaleValidationError(`Shift ${requested} not found.`);
    if (shift.status !== "OPEN") {
      throw new SaleValidationError(`Shift ${requested} is closed; a refund must come out of an open till.`);
    }
    return requested;
  }
  const own = await tx.shift.findUnique({ where: { id: sale.shiftId }, select: { status: true } });
  if (own?.status === "OPEN") return sale.shiftId;
  const voiders = await tx.shift.findFirst({ where: { cashierId: userId, status: "OPEN" }, select: { id: true }, orderBy: { openedAt: "desc" } });
  if (voiders !== null) return voiders.id;
  const cashRefund = sale.tenders.some((tender) => tender.tenderType === "CASH" && tender.status === "CONFIRMED" && tender.amount > 0n);
  if (cashRefund) {
    throw new SaleValidationError(
      `Sale ${sale.saleNumber} took cash, and its shift is closed: the refund has to come out of an open till. Open a shift, or name the shift the cash is paid from.`,
    );
  }
  return null;
}

export async function voidSale(
  db: TenantPrismaClient,
  saleId: string,
  reason: string,
  userId: string,
  options: VoidSaleOptions = {},
): Promise<VoidSaleResult> {
  const schema = resolveSchema(db);

  return db.$transaction(async (tx) => {
    const sale = await tx.sale.findUnique({
      where: { id: saleId },
      include: { lines: { include: { product: { select: { kind: true } } } }, tenders: true, customer: true },
    });
    if (sale === null) {
      throw new SaleValidationError(`Sale ${saleId} not found.`);
    }
    if (sale.status === "VOIDED") {
      throw new SaleValidationError(`Sale ${sale.saleNumber} is already voided.`);
    }
    if (sale.saleJournalEntryId === null) {
      throw new SaleValidationError(`Sale ${sale.saleNumber} has no revenue entry to reverse.`);
    }

    // A SALE THAT HAS BEEN COLLECTED AGAINST CANNOT BE VOIDED (Task 6). The void
    // reverses the original Dr 1100 and drops the customer's creditBalance by the
    // full credit amount, but a customer receipt is IMMUTABLE — its Cr 1100 and its
    // Dr cash stay put. The result would be account 1100 holding a credit balance
    // that no document explains, and a customer subledger that can never tie again.
    // Migration 0020's sale guard refuses it too; this is the clean 409.
    const received = await amountReceivedAgainstSale(tx, sale.id);
    if (received > 0n) {
      throw new SaleValidationError(saleVoidBlockedByReceipts(sale.saleNumber, received));
    }

    // Refuse if the sale's period is CLOSED — a void there needs an adjusting
    // entry in the open period, which is out of scope here.
    const revenueEntry = await tx.journalEntry.findUnique({
      where: { id: sale.saleJournalEntryId },
      select: { periodYear: true, periodMonth: true },
    });
    if (revenueEntry !== null) {
      const period = await tx.accountingPeriod.findUnique({
        where: { year_month: { year: revenueEntry.periodYear, month: revenueEntry.periodMonth } },
        select: { status: true },
      });
      if (period?.status === "CLOSED") {
        throw new SaleValidationError(
          `Sale ${sale.saleNumber} is in a closed period; void it via an adjusting entry in the open period (out of scope).`,
        );
      }
    }

    // THE TOT THE REVERSAL WILL TAKE BACK MUST BE EXACTLY THE SNAPSHOT (Task 3B.2).
    // The accrual lives inside the revenue entry, so reversing that entry returns
    // precisely what was posted — the rate in force today plays no part. Asserted
    // against Sale.totAccrued before reversing, and a disagreement fails loudly: it
    // would mean the entry and the sale disagree about what was accrued, which is a
    // defect to find, not a difference to absorb into 2110.
    const totInEntry = await tx.journalLine.findMany({
      where: { entryId: sale.saleJournalEntryId, account: { code: "2110" } },
      select: { debit: true, credit: true },
    });
    const totPosted = totInEntry.reduce((sum, line) => sum + line.credit - line.debit, 0n);
    if (totPosted !== sale.totAccrued) {
      throw new Error(
        `Sale ${sale.saleNumber}: its revenue entry accrued ${totPosted.toString()} cents of Turnover Tax but the sale records ${sale.totAccrued.toString()}. Refusing to void until the two agree.`,
      );
    }

    const voidShiftId = await resolveVoidShift(tx, sale, userId, options.shiftId);

    // Reverse ONLY the revenue entry. The cost leg is reversed by the
    // SALE_RETURN movements below, not by reversing the COGS entries.
    const reversal = await reverseJournalEntryWithinTransaction(
      tx,
      schema,
      sale.saleJournalEntryId,
      `void sale ${sale.saleNumber}: ${reason}`,
      userId,
    );

    // Return each line's stock at the EXACT cost it originally posted — never
    // the product's current average cost — so account 1200 nets to zero even if
    // the average moved between the sale and the void.
    //
    // lineCogs is that snapshot. NULL means a pre-3.1-FIX row, and for those the
    // posted cost was exactly roundHalfUp(quantity * unitCogs) because that is
    // how the old model valued an outbound movement; reconstructing it that way
    // reverses those sales exactly too, with no backfill of a write-once row.
    // The goods go back to the LOCATION THEY LEFT FROM (Task 3.2-LOC), not to
    // MAIN. Returning them to MAIN would balance every aggregate while silently
    // teleporting stock between locations: the till would stay short and MAIN
    // would gain units it never held, breaking the ownership rule that makes a
    // till's allocation trustworthy. NULL means MAIN, so a sale recorded before
    // this column existed — which genuinely did draw from MAIN — still returns
    // there, with no backfill and no special case.
    const returnLocationId = await resolveSellingLocation(
      tx,
      sale.sellingLocationId ?? undefined,
      "void",
    );

    for (const line of sale.lines) {
      // A SERVICE line (Task T-A8) took no stock and posted no cost, so there is nothing
      // to return: its void is the revenue reversal above and nothing more. (A product's
      // kind is frozen by 0027, so this is the kind it was sold as.)
      if (line.product.kind === "SERVICE") {
        continue;
      }
      const qtyMilli = decimalToMilli(line.quantity.toString());
      const postedCost =
        line.lineCogs === null ? extendCost(qtyMilli, line.unitCogs) : line.lineCogs;
      await recordStockMovementWithinTransaction(tx, schema, {
        productId: line.productId,
        movementType: "SALE_RETURN",
        quantity: line.quantity.toString(),
        unitCost: line.unitCogs,
        reversalTotalCost: postedCost,
        createdBy: userId,
        entryDate: new Date(),
        reference: `void ${sale.saleNumber}`,
        locationId: returnLocationId,
      });
    }

    // Reverse loyalty and any CREDIT tender effect on the customer.
    if (sale.customer !== null) {
      let confirmedTotal = 0n;
      let creditAmount = 0n;
      for (const tender of sale.tenders) {
        if (tender.status === "CONFIRMED") {
          confirmedTotal += tender.amount;
        }
        if (tender.tenderType === "CREDIT") {
          creditAmount += tender.amount;
        }
      }
      const points = loyaltyPointsFor(confirmedTotal);
      const newLoyalty = Math.max(0, sale.customer.loyaltyPoints - points);
      const newCredit = sale.customer.creditBalance - creditAmount;
      await tx.customer.update({
        where: { id: sale.customer.id },
        data: {
          loyaltyPoints: newLoyalty,
          creditBalance: newCredit < 0n ? 0n : newCredit,
        },
      });
    }

    await tx.sale.update({
      where: { id: sale.id },
      data: { status: "VOIDED", voidedByEntryId: reversal.id, voidReason: reason, voidShiftId },
    });

    // THE FISCAL OBLIGATION (Task 4.1). If this sale had been SIGNED by KRA, the
    // void owes KRA a CREDIT NOTE: a filed invoice for a sale that did not happen
    // is declared revenue the business never earned, and silently voiding it
    // locally would leave our books and KRA's permanently disagreeing.
    //
    // RECORDED HERE, IN THE VOID'S OWN TRANSACTION, so a signed sale can never be
    // voided without the obligation being written down atomically with it. It is
    // NOT SUBMITTED here: submission needs KRA to be reachable, and a refund at the
    // counter must never wait on a network. The credit note is pushed afterwards
    // (POST /v1/etims/invoices/:id/retry, or the retry sweep).
    //
    // Returns null for the ordinary void of an unsigned sale — nothing was filed,
    // so nothing is owed.
    const creditNote = await recordCreditNoteObligationWithinTransaction(
      tx,
      schema,
      sale.id,
      reason,
      userId,
    );

    const voided = await tx.sale.findUniqueOrThrow({
      where: { id: sale.id },
      include: SALE_INCLUDE,
    });
    return { sale: mapSale(voided), creditNote };
  });
}

export async function getSale(db: TenantPrismaClient, saleId: string): Promise<SaleResult | null> {
  const sale = await db.sale.findUnique({ where: { id: saleId }, include: SALE_INCLUDE });
  return sale === null ? null : mapSale(sale);
}

export interface ListSalesFilters {
  from?: Date;
  to?: Date;
  shiftId?: string;
  /** Case-insensitive contains on saleNumber; % and _ match themselves. */
  q?: string;
  status?: "COMPLETED" | "VOIDED";
  customerId?: string;
  take: number;
  skip: number;
}

export interface ListSalesResult {
  data: SaleResult[];
  pagination: { take: number; skip: number; total: number };
}

/** 00:00 in Nairobi of the business day a YYYY-MM-DD date (as 00:00 UTC) names, shifted by `days`. */
function businessDayStartOf(date: Date, days = 0): Date {
  return businessDayStart(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate() + days);
}

/**
 * The POS sales list, NEWEST BY BUSINESS TIME first (Task T-B-SALES-ORDER), FILTERED BY BUSINESS
 * DAY (Task T-B-SALES-FILTER).
 *
 * A sale's business time is when it HAPPENED: `businessTimestamp` for a sale captured offline
 * and synced later, else `createdAt` (an online sale is recorded as it happens). Ordering by
 * `createdAt` alone listed a synced batch in arrival order — every capture of a sync shares
 * roughly one createdAt — so a week-old sale could sit above this morning's. Prisma cannot
 * order by a COALESCE, so the page of ids is chosen in schema-qualified SQL:
 *
 *   ORDER BY COALESCE("businessTimestamp", "createdAt") DESC, "saleNumber" DESC, "id" DESC
 *
 * The two tie-breaks make the order TOTAL (saleNumber and id are unique), which is what keeps
 * LIMIT/OFFSET pages stable and non-overlapping. The rows are then loaded with the usual include
 * and returned in that order. The response shape is unchanged.
 *
 * `from` / `to` are BUSINESS DAYS (Africa/Nairobi), both inclusive, matched against the same
 * business time — so a sale rung last week and synced today is found under last week, as the
 * reports find its entry by entryDate. (They used to range over `createdAt` against 00:00 UTC,
 * which also dropped most of the `to` day itself.) The total uses the same condition.
 */
export async function listSales(
  db: TenantPrismaClient,
  filters: ListSalesFilters,
): Promise<ListSalesResult> {
  const schema = resolveSchema(db);
  const conditions: string[] = [];
  const params: unknown[] = [];
  const at = 'COALESCE("businessTimestamp", "createdAt")';
  if (filters.from !== undefined) {
    params.push(businessDayStartOf(filters.from));
    conditions.push(`${at} >= $${params.length.toString()}`);
  }
  if (filters.to !== undefined) {
    params.push(businessDayStartOf(filters.to, 1));
    conditions.push(`${at} < $${params.length.toString()}`);
  }
  if (filters.shiftId !== undefined) {
    params.push(filters.shiftId);
    conditions.push(`"shiftId" = $${params.length.toString()}`);
  }
  const q = filters.q?.trim();
  if (q) {
    params.push(`%${likeLiteral(q)}%`);
    conditions.push(`"saleNumber" ILIKE $${params.length.toString()} ESCAPE '\\'`);
  }
  if (filters.status !== undefined) {
    params.push(filters.status);
    conditions.push(`"status"::text = $${params.length.toString()}`);
  }
  if (filters.customerId !== undefined) {
    params.push(filters.customerId);
    conditions.push(`"customerId" = $${params.length.toString()}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const pageParams = [...params, filters.take, filters.skip];
  const [page, counted] = await Promise.all([
    db.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "${schema}".sales ${where}
        ORDER BY ${at} DESC, "saleNumber" DESC, "id" DESC
        LIMIT $${(pageParams.length - 1).toString()} OFFSET $${pageParams.length.toString()}`,
      ...pageParams,
    ),
    db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT COUNT(*)::bigint AS n FROM "${schema}".sales ${where}`, ...params),
  ]);

  const ids = page.map((row) => row.id);
  const rows = await db.sale.findMany({ where: { id: { in: ids } }, include: SALE_INCLUDE });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = ids.flatMap((id) => {
    const row = byId.get(id);
    return row === undefined ? [] : [row];
  });
  return {
    data: ordered.map(mapSale),
    pagination: { take: filters.take, skip: filters.skip, total: Number(counted[0]?.n ?? 0n) },
  };
}

/**
 * Resolve the location a sale draws from, or returns stock to (Task 3.2-LOC).
 *
 * An explicit id must name an existing, ACTIVE location in this tenant. Omitted
 * resolves to the tenant's MAIN pool — the same location the inventory service
 * defaulted to before the sale path was location-aware, which is what makes a
 * caller that passes nothing behave exactly as it did before.
 *
 * The resolved id is always EXPLICIT: a new sale stamps MAIN's real id rather
 * than leaving NULL. NULL is reserved for the pre-migration rows whose location
 * is MAIN by definition, mirroring how every stock movement from migration 0007
 * onward carries an explicit locationId while the historical NULLs mean MAIN.
 *
 * `context` only shapes the error message — a void failing because the till was
 * retired needs to say so, not repeat the sale-time wording.
 */
async function resolveSellingLocation(
  tx: LedgerTx,
  locationId: string | undefined,
  context: "sale" | "void",
): Promise<string> {
  if (locationId === undefined) {
    const main = await tx.location.findFirst({ where: { isDefault: true } });
    if (main === null) {
      throw new SaleValidationError(
        "No default (MAIN) location is configured for this tenant, so a sale has no source.",
      );
    }
    return main.id;
  }

  const location = await tx.location.findUnique({ where: { id: locationId } });
  if (location === null) {
    throw new SaleValidationError(`Unknown selling location ${locationId}.`);
  }
  if (!location.isActive) {
    throw new SaleValidationError(
      context === "void"
        ? `Sale cannot be voided: its selling location ${location.code} is deactivated, and returning the goods to MAIN instead would move stock to a location it never came from. Reactivate ${location.code} first.`
        : `Selling location ${location.code} is deactivated and cannot sell.`,
    );
  }
  return location.id;
}

// Reuse the single money parser; re-wrap its error as SaleValidationError so the
// route maps it to 400 with a clear field name.
function parseCents(value: string, field: string): Cents {
  try {
    return parseMoneyToCents(value);
  } catch (error) {
    throw new SaleValidationError(`${field}: ${error instanceof Error ? error.message : "invalid amount"}`);
  }
}
