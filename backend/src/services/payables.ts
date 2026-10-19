// ===========================================================================
// ACCOUNTS PAYABLE — SUPPLIER BILLS, PAYMENTS AND ALLOCATION (Module 7, Task 5.2)
//
// THIS IS THE ONLY MODULE PERMITTED TO WRITE `supplier_bills`,
// `supplier_bill_lines`, `supplier_payments` OR `supplier_payment_allocations`,
// and the only module that posts the AP-SETTLEMENT side of the general ledger.
//
// WHAT IT MUST NEVER DO, and these are not stylistic preferences:
//   * IT NEVER WRITES A STOCK TABLE. A supplier's invoice changes what we OWE,
//     never what we HOLD. The goods were valued when they ARRIVED (Task 5.1), at
//     the cost the purchase order agreed.
//   * IT NEVER POSTS TO ACCOUNT 1200. Inventory is inventory-controlled: only
//     src/services/inventory.ts may move it, and `sum(Product.stockValue) =
//     GL(1200)` would break the instant a bill debited or credited it
//     (the engineering ledger "Single-Writer Service Boundaries"). This is also WHY the price
//     variance goes to 5250 instead of adjusting stock — see below.
//
// Every general-ledger effect goes through `postJournalEntryWithinTransaction`,
// in the SAME transaction as the rows it describes.
//
// ---------------------------------------------------------------------------
// WHAT A SUPPLIER BILL DOES, FINANCIALLY
//
// Task 5.1 accrued the receipt to 2050 GRNI because goods arrive with a DELIVERY
// NOTE: there was no invoiced amount for Accounts Payable and no tax invoice to
// claim input VAT with. The bill is when all three of those facts arrive:
//
//   Dr 2050 GRNI          what the receipt accrued, at the PO price
//   Dr <expense accounts> for lines with nothing received against them
//   Dr 1400 VAT Input     the recoverable tax — ONLY now, because a VAT claim
//                         needs a tax invoice
//   Dr/Cr 5250 PPV        invoiced net minus accrued: the price difference
//   ------------------------------------------------
//   Cr 2000 Accounts Payable   the gross amount the supplier is owed
//
// THE PRICE VARIANCE IS THE INTERESTING LINE. When the supplier invoices a price
// different from the one the order agreed, there are only two places the
// difference can go: back onto the stock, or into cost of sales. It goes to 5250
// because the stock may ALREADY HAVE BEEN SOLD — restating its cost would rewrite
// a margin that has been reported, and in many cases the units it would restate
// no longer exist. Posting the difference where it happened keeps inventory at the
// cost it was received at and makes the discrepancy VISIBLE instead of absorbed.
//
// A PAYMENT is then simply `Dr 2000 / Cr <cash|bank|M-Pesa>`, allocated against
// specific invoices so that "what do we owe this supplier" has one answer.
// ---------------------------------------------------------------------------
// ===========================================================================

import type { PrismaClient as TenantPrismaClient } from "../generated/tenant/client";
import type { SupplierBillStatus, SupplierPaymentMethod } from "../generated/tenant/enums";
import { assertValidSchemaName, tenantSchemaFor } from "../db/tenant";
import { decimalToMilli, extendCost, milliToDecimalString } from "../lib/inventory-math";
import { applyRatePercent, type Cents } from "../lib/money";
import { businessDateOf } from "../lib/business-time";
import { isVatRegisteredWithinTransaction } from "./business-profile";
import { noVatRateMessage, resolveStandardVatRate } from "./tax-config";
import {
  postJournalEntryWithinTransaction,
  reverseJournalEntryWithinTransaction,
  type JournalLineInput,
  type LedgerTx,
} from "./ledger";

/** Bad input (unknown supplier, over-billing, a forbidden account). Route -> 400. */
export class PayablesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayablesValidationError";
  }
}

/** The bill's current state forbids the operation (editing a posted bill). Route -> 409. */
export class PayablesStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayablesStateError";
  }
}

// ---------------------------------------------------------------------------
// The accounts this module may touch, and the ones it may not.
//
// Listing the forbidden set as a constant rather than leaving it to the migration's
// CHECK is deliberate: the service returns a message naming the rule, and a reader
// of this file can see the boundary without going to the SQL.
// ---------------------------------------------------------------------------

const ACCT_AP = "2000";
const ACCT_GRNI = "2050";
const ACCT_VAT_INPUT = "1400";
const ACCT_PPV = "5250";
const ACCT_INVENTORY = "1200";

/** Credit accounts by payment method. CASH / BANK / MPESA, nothing else. */
const PAYMENT_CREDIT_ACCOUNT: Record<SupplierPaymentMethod, string> = {
  CASH: "1000",
  BANK: "1020",
  MPESA: "1010",
};

/**
 * Accounts a bill line may never charge as an expense. 1200 because inventory has
 * exactly one writer; the other four because they are this posting's own control
 * accounts and charging one would unbalance the reconciliation it feeds.
 * Mirrored by `supplier_bill_line_expense_account_is_not_a_control_account`.
 */
const FORBIDDEN_EXPENSE_ACCOUNTS: ReadonlySet<string> = new Set([
  ACCT_INVENTORY,
  ACCT_AP,
  ACCT_GRNI,
  ACCT_VAT_INPUT,
  ACCT_PPV,
]);

/** Classes a supplier invoice may legitimately charge. Mirrored by the bill-line trigger. */
const CHARGEABLE_CLASSES: ReadonlySet<string> = new Set(["EXPENSE", "COST_OF_SALES", "ASSET"]);

function resolveSchema(db: TenantPrismaClient): string {
  const schema = tenantSchemaFor(db);
  assertValidSchemaName(schema);
  return schema;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export type SupplierBillLineKind = "PO_MATCH" | "EXPENSE";

export interface SupplierBillLineRow {
  id: string;
  kind: SupplierBillLineKind;
  description: string;
  quantity: string;
  vatRate: string;
  lineNet: Cents;
  lineVat: Cents;
  lineTotal: Cents;
  purchaseOrderLineId: string | null;
  /** The product behind a PO_MATCH line, for a reader matching the invoice to goods. */
  productId: string | null;
  sku: string | null;
  unitCostNet: Cents | null;
  /** What this line took out of 2050 GRNI. NULL until the bill is posted. */
  grniCleared: Cents | null;
  /**
   * `lineNet - grniCleared`: positive means the supplier invoiced MORE than the
   * order agreed. Derived, never stored, because storing it would be a second
   * place the same subtraction could be got wrong.
   */
  priceVariance: Cents | null;
  expenseAccountCode: string | null;
}

export interface SupplierBillRow {
  id: string;
  billNumber: string;
  supplierId: string;
  supplierName: string;
  poId: string | null;
  poNumber: number | null;
  billDate: Date;
  dueDate: Date;
  status: SupplierBillStatus;
  subtotalNet: Cents;
  vatTotal: Cents;
  total: Cents;
  amountPaid: Cents;
  /** `total - amountPaid`. The figure the aging report buckets. */
  balance: Cents;
  currency: string;
  notes: string | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  lines: SupplierBillLineRow[];
}

export interface SupplierPaymentAllocationRow {
  id: string;
  billId: string;
  billNumber: string;
  amount: Cents;
}

export interface SupplierPaymentRow {
  id: string;
  paymentNumber: number;
  supplierId: string;
  supplierName: string;
  paymentDate: Date;
  method: SupplierPaymentMethod;
  amount: Cents;
  reference: string | null;
  notes: string | null;
  createdById: string;
  createdAt: Date;
  allocations: SupplierPaymentAllocationRow[];
}

const PAYMENT_INCLUDE = {
  supplier: { select: { name: true } },
  allocations: {
    include: { bill: { select: { billNumber: true } } },
    orderBy: { createdAt: "asc" },
  },
} as const;

interface RawPayment {
  id: string;
  paymentNumber: number;
  supplierId: string;
  paymentDate: Date;
  method: SupplierPaymentMethod;
  amount: bigint;
  reference: string | null;
  notes: string | null;
  createdById: string;
  createdAt: Date;
  supplier: { name: string };
  allocations: Array<{ id: string; billId: string; amount: bigint; bill: { billNumber: string } }>;
}

function toPaymentRow(payment: RawPayment): SupplierPaymentRow {
  return {
    id: payment.id,
    paymentNumber: payment.paymentNumber,
    supplierId: payment.supplierId,
    supplierName: payment.supplier.name,
    paymentDate: payment.paymentDate,
    method: payment.method,
    amount: payment.amount,
    reference: payment.reference,
    notes: payment.notes,
    createdById: payment.createdById,
    createdAt: payment.createdAt,
    allocations: payment.allocations.map((allocation) => ({
      id: allocation.id,
      billId: allocation.billId,
      billNumber: allocation.bill.billNumber,
      amount: allocation.amount,
    })),
  };
}

const BILL_INCLUDE = {
  supplier: { select: { name: true } },
  order: { select: { poNumber: true } },
  lines: {
    include: {
      purchaseOrderLine: {
        select: { productId: true, product: { select: { sku: true } } },
      },
    },
    orderBy: { createdAt: "asc" },
  },
} as const;

interface RawBillLine {
  id: string;
  description: string;
  quantity: { toString(): string };
  vatRate: { toString(): string };
  lineNet: bigint;
  lineVat: bigint;
  lineTotal: bigint;
  purchaseOrderLineId: string | null;
  unitCostNet: bigint | null;
  grniCleared: bigint | null;
  expenseAccountCode: string | null;
  purchaseOrderLine: { productId: string; product: { sku: string } } | null;
}

interface RawBillRow {
  id: string;
  billNumber: string;
  supplierId: string;
  poId: string | null;
  billDate: Date;
  dueDate: Date;
  status: SupplierBillStatus;
  subtotalNet: bigint;
  vatTotal: bigint;
  total: bigint;
  amountPaid: bigint;
  currency: string;
  notes: string | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  supplier: { name: string };
  order: { poNumber: number } | null;
  lines: RawBillLine[];
}

function lineKind(line: RawBillLine): SupplierBillLineKind {
  // The discriminator IS which reference is present; the CHECK guarantees exactly
  // one of them is, so there is no third case to handle.
  return line.purchaseOrderLineId !== null ? "PO_MATCH" : "EXPENSE";
}

function toLineRow(line: RawBillLine): SupplierBillLineRow {
  return {
    id: line.id,
    kind: lineKind(line),
    description: line.description,
    quantity: milliToDecimalString(decimalToMilli(line.quantity.toString())),
    vatRate: line.vatRate.toString(),
    lineNet: line.lineNet,
    lineVat: line.lineVat,
    lineTotal: line.lineTotal,
    purchaseOrderLineId: line.purchaseOrderLineId,
    productId: line.purchaseOrderLine?.productId ?? null,
    sku: line.purchaseOrderLine?.product.sku ?? null,
    unitCostNet: line.unitCostNet,
    grniCleared: line.grniCleared,
    priceVariance: line.grniCleared === null ? null : line.lineNet - line.grniCleared,
    expenseAccountCode: line.expenseAccountCode,
  };
}

function toBillRow(bill: RawBillRow): SupplierBillRow {
  return {
    id: bill.id,
    billNumber: bill.billNumber,
    supplierId: bill.supplierId,
    supplierName: bill.supplier.name,
    poId: bill.poId,
    poNumber: bill.order?.poNumber ?? null,
    billDate: bill.billDate,
    dueDate: bill.dueDate,
    status: bill.status,
    subtotalNet: bill.subtotalNet,
    vatTotal: bill.vatTotal,
    total: bill.total,
    amountPaid: bill.amountPaid,
    balance: bill.total - bill.amountPaid,
    currency: bill.currency,
    notes: bill.notes,
    createdById: bill.createdById,
    createdAt: bill.createdAt,
    updatedAt: bill.updatedAt,
    lines: bill.lines.map(toLineRow),
  };
}

// ---------------------------------------------------------------------------
// Numbering and locking
// ---------------------------------------------------------------------------

/**
 * Allocate the next payment number from the tenant's own sequence.
 *
 * Schema-qualified, because the pg adapter does not set search_path (the engineering ledger
 * "Raw SQL and Tenant Schema Resolution"). Monotonic and unique, not gap-free —
 * the trade recorded in migration 0018(b).
 */
async function nextPaymentNumber(tx: LedgerTx, schema: string): Promise<number> {
  assertValidSchemaName(schema);
  const rows = await tx.$queryRawUnsafe<Array<{ v: bigint }>>(
    `SELECT nextval('"${schema}"."supplier_payment_number_seq"') AS v`,
  );
  const first = rows[0];
  if (first === undefined) {
    throw new Error("Failed to allocate a supplier payment number.");
  }
  return Number(first.v);
}

/**
 * Load a bill with its lines under a ROW LOCK.
 *
 * The lock is what makes concurrent operations on one invoice safe: two payments
 * allocated to the same bill at the same instant serialise on the bill row, so the
 * second sees the first's `amountPaid` and cannot over-pay against a stale
 * reading. The `amountPaid <= total` CHECK is the backstop behind the lock.
 */
async function lockBill(tx: LedgerTx, schema: string, id: string): Promise<RawBillRow> {
  assertValidSchemaName(schema);
  const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT "id" FROM "${schema}".supplier_bills WHERE "id" = $1 FOR UPDATE`,
    id,
  );
  if (locked[0] === undefined) {
    throw new PayablesValidationError(`Unknown supplier bill ${id}.`);
  }
  const bill = await tx.supplierBill.findUnique({ where: { id }, include: BILL_INCLUDE });
  if (bill === null) {
    throw new PayablesValidationError(`Unknown supplier bill ${id}.`);
  }
  return bill;
}

/**
 * Lock the purchase order a bill is matched to.
 *
 * Posting a bill moves `billedQty` on the order's lines, and the three-way-match
 * CHECK is evaluated per row. Serialising on the ORDER means two bills against the
 * same order cannot each read the same remaining quantity and each bill it.
 */
async function lockOrderForBilling(tx: LedgerTx, schema: string, poId: string): Promise<void> {
  assertValidSchemaName(schema);
  const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT "id" FROM "${schema}".purchase_orders WHERE "id" = $1 FOR UPDATE`,
    poId,
  );
  if (locked[0] === undefined) {
    throw new PayablesValidationError(`Unknown purchase order ${poId}.`);
  }
}

// ---------------------------------------------------------------------------
// Payment terms -> due date
// ---------------------------------------------------------------------------

/**
 * Derive a due date from the supplier's free-text payment terms.
 *
 * `Supplier.paymentTerms` is free text ("Net 30", "30 days", "Cash on delivery"),
 * because it is a note a shopkeeper typed, not a structured field. So this parses
 * what is parseable and REFUSES TO GUESS at anything else: an unparseable term
 * yields the bill date itself — due on receipt.
 *
 * THAT FALLBACK IS THE SAFE DIRECTION, and the choice matters. Due-on-receipt ages
 * the invoice immediately, so it appears in the aging report and gets looked at.
 * Inventing a 30-day term from "Cash on delivery" would do the opposite: hide a
 * bill that is already overdue inside the "current" bucket for a month.
 */
const NET_TERMS_PATTERN = /(\d{1,3})\s*(?:day|days)?/i;

export function deriveDueDate(billDate: Date, paymentTerms: string | null): Date {
  if (paymentTerms === null) {
    return billDate;
  }
  const terms = paymentTerms.trim();
  if (terms === "") {
    return billDate;
  }
  // "Cash on delivery", "COD", "Prepaid" and friends carry no credit period at all.
  // Matching a bare number inside them would be worse than not matching: "Net 7
  // days from month end" is not 7 days, and guessing would understate the age.
  if (!/^net\b/i.test(terms) && !/^\d/.test(terms)) {
    return billDate;
  }
  const match = NET_TERMS_PATTERN.exec(terms);
  if (match === null) {
    return billDate;
  }
  const days = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isInteger(days) || days < 0 || days > 365) {
    return billDate;
  }
  const due = new Date(billDate.getTime());
  due.setUTCDate(due.getUTCDate() + days);
  return due;
}

// ---------------------------------------------------------------------------
// 1. CREATE A DRAFT BILL — no general-ledger effect whatsoever
// ---------------------------------------------------------------------------

export interface BillLineInput {
  description: string;
  /** Decimal(14,3) string. Positive. For a PO_MATCH line this is the BILLED quantity. */
  quantity: string;
  /**
   * Cost per unit in cents. For a PO_MATCH line it is the NET unit cost the
   * supplier invoiced; for an EXPENSE line, quantity x unitCost is the line's net
   * amount (a lump sum is quantity "1" and the whole amount here).
   */
  unitCost: Cents;
  /** Percentage as a decimal string. Omitted uses the tenant's default rate. */
  vatRate?: string;
  /** PO_MATCH: the purchase order line this invoices. Mutually exclusive with the next. */
  purchaseOrderLineId?: string;
  /** EXPENSE: the 4-digit chart code to charge. Mutually exclusive with the previous. */
  expenseAccountCode?: string;
}

export interface CreateSupplierBillInput {
  supplierId: string;
  /** The SUPPLIER'S invoice reference. Unique per supplier — the duplicate guard. */
  billNumber: string;
  poId?: string;
  billDate: Date;
  /** Omitted derives from the supplier's payment terms, else equals billDate. */
  dueDate?: Date;
  notes?: string;
  lines: BillLineInput[];
  createdById: string;
}

interface PricedBillLine {
  description: string;
  quantityMilli: bigint;
  vatRate: string;
  lineNet: Cents;
  lineVat: Cents;
  lineTotal: Cents;
  purchaseOrderLineId: string | null;
  unitCostNet: Cents | null;
  expenseAccountCode: string | null;
}

/**
 * Price every line and total the invoice.
 *
 * `extendCost` is the SAME primitive the sale path, the purchase order and every
 * receipt use: the quantity is held in thousandths and the product is rounded ONCE
 * through `roundHalfUp`. There is deliberately no second multiplication rule for
 * supplier bills — a bill's figures have to agree with the PO's to the cent for the
 * price variance to mean anything, and the only way to guarantee that is to compute
 * both the same way.
 *
 * VAT: `applyRatePercent` is the single rate primitive, and the rate is a Decimal
 * string that never touches the money parser's semantics.
 */
/**
 * The standard VAT rate a bill line defaults to: the rate in force on the BILL DATE
 * (Task 3B.1), or "0.00" for a non-registered tenant, which recovers no VAT and needs
 * no rate at all. A registered tenant's bill dated outside every schedule is refused.
 */
async function standardRateForBill(tx: LedgerTx, isVatRegistered: boolean, billDate: Date): Promise<string> {
  if (!isVatRegistered) {
    return "0.00";
  }
  const resolved = await resolveStandardVatRate(tx, billDate);
  if (resolved === null) {
    throw new PayablesValidationError(noVatRateMessage(billDate));
  }
  return resolved.rate;
}

async function priceBillLines(
  tx: LedgerTx,
  lines: ReadonlyArray<BillLineInput>,
  poId: string | null,
  isVatRegistered: boolean,
  standardVatRate: string,
): Promise<{ priced: PricedBillLine[]; subtotalNet: Cents; vatTotal: Cents; total: Cents }> {
  if (lines.length === 0) {
    throw new PayablesValidationError("A supplier bill needs at least one line.");
  }

  const priced: PricedBillLine[] = [];
  let subtotalNet = 0n;
  let vatTotal = 0n;

  // Accumulated per PO line, so a bill that references the same line twice is
  // checked against the TOTAL it is asking to bill rather than line by line.
  const billedPerPoLine = new Map<string, bigint>();

  for (const [index, line] of lines.entries()) {
    const position = index + 1;
    const hasPoLine = line.purchaseOrderLineId !== undefined;
    const hasExpense = line.expenseAccountCode !== undefined;

    if (hasPoLine === hasExpense) {
      throw new PayablesValidationError(
        `Line ${position.toString()}: give exactly one of purchaseOrderLineId (goods received against an order) or expenseAccountCode (a cost with nothing received against it).`,
      );
    }
    if (line.description.trim() === "") {
      throw new PayablesValidationError(`Line ${position.toString()}: description is required.`);
    }

    const quantityMilli = decimalToMilli(line.quantity);
    if (quantityMilli <= 0n) {
      throw new PayablesValidationError(`Line ${position.toString()}: quantity must be positive.`);
    }
    if (line.unitCost < 0n) {
      throw new PayablesValidationError(
        `Line ${position.toString()}: unitCost must not be negative.`,
      );
    }

    const lineNet = extendCost(quantityMilli, line.unitCost);

    // THE RATE IS ZERO FOR A NON-REGISTERED TENANT, always, whatever the caller
    // sent. The column exists to drive the recoverable-VAT figure; a business that
    // cannot recover VAT has none, and the tax it paid is already inside `lineNet`
    // (the same regime-dependent meaning PurchaseOrderLine.unitCost carries).
    // Storing a non-zero rate beside a zero VAT amount would be a row that
    // contradicts itself.
    // A line without its own rate takes the STANDARD rate in force on the bill date
    // (Task 3B.1: the effective StatutorySchedule, the only copy of that figure).
    const vatRate = isVatRegistered ? (line.vatRate ?? standardVatRate) : "0.00";
    const lineVat = isVatRegistered ? applyRatePercent(lineNet, vatRate) : 0n;

    let purchaseOrderLineId: string | null = null;
    let unitCostNet: Cents | null = null;
    let expenseAccountCode: string | null = null;

    if (line.purchaseOrderLineId !== undefined) {
      if (poId === null) {
        throw new PayablesValidationError(
          `Line ${position.toString()}: a PO-matched line needs the bill to name its purchase order (poId).`,
        );
      }
      const poLine = await tx.purchaseOrderLine.findUnique({
        where: { id: line.purchaseOrderLineId },
        select: {
          id: true,
          poId: true,
          receivedQty: true,
          billedQty: true,
          product: { select: { sku: true } },
        },
      });
      if (poLine === null) {
        throw new PayablesValidationError(
          `Line ${position.toString()}: unknown purchase order line ${line.purchaseOrderLineId}.`,
        );
      }
      if (poLine.poId !== poId) {
        throw new PayablesValidationError(
          `Line ${position.toString()}: purchase order line ${line.purchaseOrderLineId} belongs to a different order. A bill may only clear GRNI raised by its own order.`,
        );
      }

      // THE THREE-WAY MATCH, checked here for a clean message and enforced by the
      // `purchase_order_line_no_over_billing` CHECK regardless.
      const receivedMilli = decimalToMilli(poLine.receivedQty.toString());
      const billedMilli = decimalToMilli(poLine.billedQty.toString());
      const alreadyOnThisBill = billedPerPoLine.get(poLine.id) ?? 0n;
      const available = receivedMilli - billedMilli - alreadyOnThisBill;
      if (quantityMilli > available) {
        throw new PayablesValidationError(
          `Line ${position.toString()} (${poLine.product.sku}): billing ${milliToDecimalString(quantityMilli)} but only ${milliToDecimalString(available > 0n ? available : 0n)} has been received and not yet billed. A supplier cannot invoice more than arrived.`,
        );
      }
      billedPerPoLine.set(poLine.id, alreadyOnThisBill + quantityMilli);

      purchaseOrderLineId = poLine.id;
      unitCostNet = line.unitCost;
    } else if (line.expenseAccountCode !== undefined) {
      const code = line.expenseAccountCode.trim();
      if (FORBIDDEN_EXPENSE_ACCOUNTS.has(code)) {
        throw new PayablesValidationError(
          `Line ${position.toString()}: account ${code} is a control account of the payables posting itself and can never be charged as an expense. 1200 Inventory moves only through the inventory service; 2000, 2050, 1400 and 5250 are this entry's own accounts.`,
        );
      }
      const account = await tx.account.findUnique({
        where: { code },
        select: { code: true, accountClass: true, isActive: true },
      });
      if (account === null) {
        throw new PayablesValidationError(
          `Line ${position.toString()}: no account with code ${code}.`,
        );
      }
      if (!account.isActive) {
        throw new PayablesValidationError(
          `Line ${position.toString()}: account ${code} is inactive and cannot be charged.`,
        );
      }
      if (!CHARGEABLE_CLASSES.has(account.accountClass)) {
        throw new PayablesValidationError(
          `Line ${position.toString()}: account ${code} is a ${account.accountClass} account. A supplier bill may only charge EXPENSE, COST_OF_SALES or ASSET accounts — charging a liability, equity or revenue account would mis-state the financial statements while leaving the entry perfectly balanced.`,
        );
      }
      expenseAccountCode = code;
    }

    subtotalNet += lineNet;
    vatTotal += lineVat;
    priced.push({
      description: line.description.trim(),
      quantityMilli,
      vatRate,
      lineNet,
      lineVat,
      lineTotal: lineNet + lineVat,
      purchaseOrderLineId,
      unitCostNet,
      expenseAccountCode,
    });
  }

  const total = subtotalNet + vatTotal;
  if (total <= 0n) {
    throw new PayablesValidationError(
      "A supplier bill must total more than zero. A zero invoice is not a document anybody owes against, and no payment could ever settle it.",
    );
  }

  return { priced, subtotalNet, vatTotal, total };
}

/**
 * CREATE A DRAFT BILL. **Posts NOTHING to the ledger.**
 *
 * A keyed-in invoice that has not been checked against the delivery is data entry,
 * not a liability — which is exactly why DRAFT is a state and not a flag. Nothing
 * moves until `postSupplierBill`, so a mis-keyed invoice is corrected by editing or
 * discarding it rather than by a reversing entry.
 */
export async function createSupplierBill(
  db: TenantPrismaClient,
  input: CreateSupplierBillInput,
): Promise<SupplierBillRow> {
  // No raw SQL here, so no schema to resolve: every write goes through Prisma's
  // own schema-qualified client.
  const billNumber = input.billNumber.trim();
  if (billNumber === "") {
    throw new PayablesValidationError(
      "billNumber is required: it is the supplier's own invoice reference and the basis of the duplicate-payment guard.",
    );
  }

  return db.$transaction(async (tx) => {
    const supplier = await tx.supplier.findUnique({
      where: { id: input.supplierId },
      select: { id: true, name: true, isActive: true, paymentTerms: true },
    });
    if (supplier === null) {
      throw new PayablesValidationError(`Unknown supplier ${input.supplierId}.`);
    }
    if (!supplier.isActive) {
      throw new PayablesValidationError(
        `Supplier ${supplier.name} is inactive and cannot be billed.`,
      );
    }

    const duplicate = await tx.supplierBill.findUnique({
      where: { supplierId_billNumber: { supplierId: supplier.id, billNumber } },
      select: { id: true, status: true },
    });
    if (duplicate !== null) {
      throw new PayablesStateError(
        `Supplier ${supplier.name} already has a bill numbered "${billNumber}" (currently ${duplicate.status}). This is the duplicate-payment guard: the same invoice arriving twice must not become two payables.`,
      );
    }

    if (input.poId !== undefined) {
      const order = await tx.purchaseOrder.findUnique({
        where: { id: input.poId },
        select: { id: true, poNumber: true, supplierId: true, status: true },
      });
      if (order === null) {
        throw new PayablesValidationError(`Unknown purchase order ${input.poId}.`);
      }
      if (order.supplierId !== supplier.id) {
        throw new PayablesValidationError(
          `Purchase order ${order.poNumber.toString()} belongs to a different supplier. An invoice may only be matched to its own supplier's order.`,
        );
      }
      if (order.status === "DRAFT" || order.status === "CANCELLED") {
        throw new PayablesStateError(
          `Purchase order ${order.poNumber.toString()} is ${order.status}: nothing can have been received against it, so there is nothing for an invoice to match.`,
        );
      }
    }

    // THE VAT DECISION IS MADE HERE, at keying time, under the regime in force now.
    // It is NOT re-made at posting: a later regime change is not retroactive (see
    // src/services/business-profile.ts), and the invoice was received under the
    // regime that applied when it arrived.
    const isVatRegistered = await isVatRegisteredWithinTransaction(tx);
    const standardVatRate = await standardRateForBill(tx, isVatRegistered, input.billDate);

    const { priced, subtotalNet, vatTotal, total } = await priceBillLines(
      tx,
      input.lines,
      input.poId ?? null,
      isVatRegistered,
      standardVatRate,
    );

    const dueDate = input.dueDate ?? deriveDueDate(input.billDate, supplier.paymentTerms);
    if (dueDate < input.billDate) {
      throw new PayablesValidationError(
        "dueDate cannot be before billDate. Due on the bill date itself is legitimate — that is due on receipt.",
      );
    }

    const bill = await tx.supplierBill.create({
      data: {
        billNumber,
        supplierId: supplier.id,
        ...(input.poId !== undefined ? { poId: input.poId } : {}),
        billDate: input.billDate,
        dueDate,
        subtotalNet,
        vatTotal,
        total,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        createdById: input.createdById,
        lines: {
          create: priced.map((line) => ({
            description: line.description,
            quantity: milliToDecimalString(line.quantityMilli),
            vatRate: line.vatRate,
            lineNet: line.lineNet,
            lineVat: line.lineVat,
            lineTotal: line.lineTotal,
            ...(line.purchaseOrderLineId !== null
              ? { purchaseOrderLineId: line.purchaseOrderLineId, unitCostNet: line.unitCostNet }
              : {}),
            ...(line.expenseAccountCode !== null
              ? { expenseAccountCode: line.expenseAccountCode }
              : {}),
          })),
        },
      },
      include: BILL_INCLUDE,
    });

    return toBillRow(bill);
  });
}

// ---------------------------------------------------------------------------
// 2. EDIT A DRAFT
// ---------------------------------------------------------------------------

export interface UpdateSupplierBillInput {
  billDate?: Date;
  dueDate?: Date;
  notes?: string | null;
  /** Supplied: the line set is REPLACED wholesale. */
  lines?: BillLineInput[];
}

/**
 * Edit a DRAFT bill. **409 once it has been posted**, and migration 0018's trigger
 * refuses it too.
 *
 * The line set is REPLACED rather than merged when supplied, exactly as a DRAFT
 * purchase order's is: a partial merge would need a per-line identity the client
 * does not have, and guessing one silently drops a quantity change. A DRAFT has
 * cleared no GRNI and carries no `grniCleared`, so there is nothing to preserve.
 */
export async function updateSupplierBill(
  db: TenantPrismaClient,
  id: string,
  input: UpdateSupplierBillInput,
): Promise<SupplierBillRow> {
  const schema = resolveSchema(db);

  return db.$transaction(async (tx) => {
    const bill = await lockBill(tx, schema, id);
    if (bill.status !== "DRAFT") {
      throw new PayablesStateError(
        `Supplier bill ${bill.billNumber} is ${bill.status} and can no longer be edited: it has been posted to the ledger, so its figures are a journal entry that exists. Cancel it while it is unpaid, or correct it with a supplier credit note.`,
      );
    }

    const supplier = await tx.supplier.findUniqueOrThrow({
      where: { id: bill.supplierId },
      select: { paymentTerms: true },
    });

    const billDate = input.billDate ?? bill.billDate;
    let subtotalNet = bill.subtotalNet;
    let vatTotal = bill.vatTotal;

    if (input.lines !== undefined) {
      const isVatRegistered = await isVatRegisteredWithinTransaction(tx);
      const priced = await priceBillLines(
        tx,
        input.lines,
        bill.poId,
        isVatRegistered,
        await standardRateForBill(tx, isVatRegistered, billDate),
      );
      subtotalNet = priced.subtotalNet;
      vatTotal = priced.vatTotal;

      await tx.supplierBillLine.deleteMany({ where: { billId: bill.id } });
      for (const line of priced.priced) {
        await tx.supplierBillLine.create({
          data: {
            billId: bill.id,
            description: line.description,
            quantity: milliToDecimalString(line.quantityMilli),
            vatRate: line.vatRate,
            lineNet: line.lineNet,
            lineVat: line.lineVat,
            lineTotal: line.lineTotal,
            ...(line.purchaseOrderLineId !== null
              ? { purchaseOrderLineId: line.purchaseOrderLineId, unitCostNet: line.unitCostNet }
              : {}),
            ...(line.expenseAccountCode !== null
              ? { expenseAccountCode: line.expenseAccountCode }
              : {}),
          },
        });
      }
    }

    const dueDate =
      input.dueDate ??
      (input.billDate !== undefined
        ? deriveDueDate(billDate, supplier.paymentTerms)
        : bill.dueDate);
    if (dueDate < billDate) {
      throw new PayablesValidationError("dueDate cannot be before billDate.");
    }

    const updated = await tx.supplierBill.update({
      where: { id: bill.id },
      data: {
        billDate,
        dueDate,
        subtotalNet,
        vatTotal,
        total: subtotalNet + vatTotal,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
      include: BILL_INCLUDE,
    });
    return toBillRow(updated);
  });
}

// ---------------------------------------------------------------------------
// 3. POST A BILL — the operation with the financial effect
// ---------------------------------------------------------------------------

interface PoMatchPosting {
  /** What this line takes out of GRNI, at the price the receipt accrued. */
  grniCleared: Cents;
  /** What the supplier actually invoiced for it. The gap between the two is the PPV. */
  invoiceNet: Cents;
}

/**
 * How much GRNI a purchase order line still carries, in cents.
 *
 * ACCRUED comes from the IMMUTABLE STOCK MOVEMENTS — `totalCost` is literally the
 * figure each receipt credited to 2050, so this is not a reconstruction, it is the
 * posted history. CLEARED comes from the `grniCleared` stamped on the bill lines
 * that have actually posted; CANCELLED bills are excluded because their entries
 * have been REVERSED, which put the GRNI back.
 */
async function grniRemainingForPoLine(
  tx: LedgerTx,
  purchaseOrderLineId: string,
): Promise<{ accrued: Cents; cleared: Cents; remaining: Cents }> {
  const accruedAgg = await tx.stockMovement.aggregate({
    where: { purchaseOrderLineId, movementType: "PURCHASE_RECEIPT" },
    _sum: { totalCost: true },
  });
  const clearedAgg = await tx.supplierBillLine.aggregate({
    where: {
      purchaseOrderLineId,
      grniCleared: { not: null },
      bill: { status: { notIn: ["DRAFT", "CANCELLED"] } },
    },
    _sum: { grniCleared: true },
  });
  const accrued = accruedAgg._sum.totalCost ?? 0n;
  const cleared = clearedAgg._sum.grniCleared ?? 0n;
  return { accrued, cleared, remaining: accrued - cleared };
}

/**
 * POST A SUPPLIER BILL — ONE TRANSACTION, ALL OF IT.
 *
 * In a single transaction this clears GRNI, recognises input VAT, posts the price
 * variance, credits Accounts Payable, advances each PO line's billed quantity and
 * moves the bill to AWAITING_PAYMENT. Either all of it commits or none does: a bill
 * marked posted without its entry would leave Accounts Payable understated, and an
 * entry without the bill would leave a credit nothing explains.
 *
 * THE GRNI ARITHMETIC, and why it is not simply `billedQty x unitCost`:
 *
 * GRNI was accrued RECEIPT BY RECEIPT, each extension rounded once. A bill covering
 * several receipts in one line cannot reproduce that sum by re-rounding the total —
 * receive 1.5 then 1.5 at 3.33 and the accrual is 500 cents, while 3.0 x 3.33
 * re-rounds to 499. So:
 *
 *   * a line that FULLY bills its PO line clears the ENTIRE REMAINING ACCRUAL;
 *   * a line that partly bills it clears `quantity x unitCost`, capped at the
 *     remainder.
 *
 * That is the same residual discipline as the DEPLETING outbound rule in inventory
 * valuation (the engineering ledger "Inventory Valuation Is Carrying-Value-Authoritative"): the
 * last movement out takes the whole remainder, so the account reaches EXACTLY zero
 * instead of nearly zero. The rounding residue lands in 5250, which is precisely
 * where a difference between the accrued and the invoiced price belongs.
 */
export async function postSupplierBill(
  db: TenantPrismaClient,
  id: string,
  postedById: string,
): Promise<SupplierBillRow> {
  const schema = resolveSchema(db);

  return db.$transaction(async (tx) => {
    const bill = await lockBill(tx, schema, id);
    if (bill.status !== "DRAFT") {
      throw new PayablesStateError(
        `Supplier bill ${bill.billNumber} is already ${bill.status}: it has been posted and cannot be posted again.`,
      );
    }
    if (bill.lines.length === 0) {
      throw new PayablesValidationError(
        `Supplier bill ${bill.billNumber} has no lines, so there is nothing to post.`,
      );
    }
    if (bill.poId !== null) {
      await lockOrderForBilling(tx, schema, bill.poId);
    }

    // --- Work out every leg of the entry -----------------------------------
    const poMatches: PoMatchPosting[] = [];
    const expenseDebits = new Map<string, Cents>();
    let grniTotal = 0n;
    let vatTotal = 0n;
    let expenseTotal = 0n;

    for (const line of bill.lines) {
      vatTotal += line.lineVat;

      if (line.purchaseOrderLineId === null) {
        const code = line.expenseAccountCode;
        if (code === null) {
          // Unreachable: the discriminator CHECK guarantees one of the two.
          throw new Error(
            `Supplier bill line ${line.id} has neither a purchase order line nor an expense account.`,
          );
        }
        expenseDebits.set(code, (expenseDebits.get(code) ?? 0n) + line.lineNet);
        expenseTotal += line.lineNet;
        continue;
      }

      const poLine = await tx.purchaseOrderLine.findUniqueOrThrow({
        where: { id: line.purchaseOrderLineId },
        select: {
          id: true,
          unitCost: true,
          receivedQty: true,
          billedQty: true,
          billedNet: true,
          product: { select: { sku: true } },
        },
      });

      const quantityMilli = decimalToMilli(line.quantity.toString());
      const receivedMilli = decimalToMilli(poLine.receivedQty.toString());
      const billedMilli = decimalToMilli(poLine.billedQty.toString());
      const nextBilledMilli = billedMilli + quantityMilli;

      if (nextBilledMilli > receivedMilli) {
        throw new PayablesValidationError(
          `${poLine.product.sku}: billing ${milliToDecimalString(quantityMilli)} would take the billed quantity past the ${milliToDecimalString(receivedMilli)} received. A supplier cannot invoice more than arrived.`,
        );
      }

      const { remaining } = await grniRemainingForPoLine(tx, poLine.id);
      const fullyBilled = nextBilledMilli === receivedMilli;
      // The residual rule. See the function note above.
      const proportional = extendCost(quantityMilli, poLine.unitCost);
      let grniCleared = fullyBilled ? remaining : proportional;
      if (grniCleared > remaining) {
        grniCleared = remaining;
      }
      if (grniCleared < 0n) {
        grniCleared = 0n;
      }

      // Stamp the line BEFORE the status flip: the bill-line guard freezes the set
      // once the bill leaves DRAFT, so this order is required (migration 0018(h)).
      await tx.supplierBillLine.update({
        where: { id: line.id },
        data: { grniCleared },
      });

      await tx.purchaseOrderLine.update({
        where: { id: poLine.id },
        data: {
          billedQty: milliToDecimalString(nextBilledMilli),
          billedNet: poLine.billedNet + line.lineNet,
        },
      });

      grniTotal += grniCleared;
      poMatches.push({ grniCleared, invoiceNet: line.lineNet });
    }

    // --- Build the entry ---------------------------------------------------
    // PPV is the NET difference across the whole invoice: what we were invoiced for
    // goods, minus what we had accrued for them. One line, not one per PO line,
    // because the variance is a property of the invoice as a whole and a dozen
    // one-cent rounding lines would bury the real price differences.
    const invoicedGoodsNet = poMatches.reduce((sum, match) => sum + match.invoiceNet, 0n);
    const priceVariance = invoicedGoodsNet - grniTotal;

    const lines: JournalLineInput[] = [];
    if (grniTotal > 0n) {
      lines.push({
        accountCode: ACCT_GRNI,
        debit: grniTotal,
        memo: "Clear goods received not invoiced",
      });
    }
    // Sorted so the entry reads in chart order rather than in input order.
    for (const code of [...expenseDebits.keys()].sort()) {
      const amount = expenseDebits.get(code) ?? 0n;
      if (amount > 0n) {
        lines.push({ accountCode: code, debit: amount, memo: "Supplier invoice" });
      }
    }
    if (vatTotal > 0n) {
      lines.push({
        accountCode: ACCT_VAT_INPUT,
        debit: vatTotal,
        memo: "Recoverable input VAT on supplier invoice",
      });
    }
    if (priceVariance > 0n) {
      lines.push({
        accountCode: ACCT_PPV,
        debit: priceVariance,
        memo: "Invoiced above the accrued purchase price",
      });
    } else if (priceVariance < 0n) {
      lines.push({
        accountCode: ACCT_PPV,
        credit: -priceVariance,
        memo: "Invoiced below the accrued purchase price",
      });
    }
    lines.push({
      accountCode: ACCT_AP,
      credit: bill.total,
      memo: `Owed to ${bill.supplier.name}`,
    });

    // ASSERT THE ENTRY BALANCES BEFORE POSTING IT, AND FAIL LOUDLY IF IT DOES NOT.
    //
    // The ledger's deferred constraint would catch it at COMMIT, but it would
    // report an imbalance with no idea which bill or which arithmetic produced it.
    // This is NOT a plug: nothing here adjusts a figure to make the sums meet. A
    // mismatch means the bill's own total disagrees with its lines, which is a
    // defect to be found, not a difference to be absorbed into an account.
    const debits = lines.reduce((sum, line) => sum + (line.debit ?? 0n), 0n);
    const credits = lines.reduce((sum, line) => sum + (line.credit ?? 0n), 0n);
    if (debits !== credits) {
      throw new Error(
        `Supplier bill ${bill.billNumber} would post an unbalanced entry: debits ${debits.toString()} vs credits ${credits.toString()} (GRNI ${grniTotal.toString()}, expenses ${expenseTotal.toString()}, VAT ${vatTotal.toString()}, variance ${priceVariance.toString()}, invoice total ${bill.total.toString()}). Refusing to post; this is a defect in the bill's figures, not a rounding to absorb.`,
      );
    }

    await postJournalEntryWithinTransaction(tx, schema, {
      entryDate: bill.billDate,
      description: `Supplier invoice ${bill.billNumber} — ${bill.supplier.name}`,
      reference: bill.billNumber,
      source: "PURCHASE",
      sourceId: bill.id,
      createdBy: postedById,
      lines,
    });

    const posted = await tx.supplierBill.update({
      where: { id: bill.id },
      data: { status: "AWAITING_PAYMENT" },
      include: BILL_INCLUDE,
    });
    return toBillRow(posted);
  });
}

// ---------------------------------------------------------------------------
// 4. CANCEL
// ---------------------------------------------------------------------------

/**
 * CANCEL A BILL. Permitted from DRAFT and from AWAITING_PAYMENT — never once any
 * payment has been allocated.
 *
 * From DRAFT there is nothing to undo: no entry was posted, no GRNI was cleared,
 * no quantity was billed.
 *
 * From AWAITING_PAYMENT the bill HAS posted, so cancelling it:
 *   1. REVERSES its journal entry through the ledger's reversal path — a new
 *      opposite entry, never an edit, because a posted entry is immutable
 *      (the engineering ledger). GRNI goes back up, input VAT comes back off, the variance
 *      unwinds and Accounts Payable is relieved.
 *   2. GIVES THE BILLED QUANTITY BACK. The goods are still received-and-not-
 *      invoiced, so `billedQty` and `billedNet` must fall — which is exactly why
 *      migration 0018 deliberately does NOT make them monotonic, unlike
 *      `receivedQty`. The `grniCleared` stamps stay on the cancelled lines as the
 *      record of what that bill did, and every later GRNI calculation excludes
 *      cancelled bills.
 *
 * ONCE MONEY HAS GONE OUT, CANCELLATION IS REFUSED. "This invoice never happened"
 * is then false, and the correction is a supplier credit note — deliberately out of
 * this task's scope, which is precisely why this path must not be widened into a
 * general undo.
 */
export async function cancelSupplierBill(
  db: TenantPrismaClient,
  id: string,
  reason: string,
  cancelledById: string,
): Promise<SupplierBillRow> {
  const schema = resolveSchema(db);

  return db.$transaction(async (tx) => {
    const bill = await lockBill(tx, schema, id);

    if (bill.status === "CANCELLED") {
      throw new PayablesStateError(`Supplier bill ${bill.billNumber} is already cancelled.`);
    }
    if (bill.status === "PAID" || bill.status === "PARTIALLY_PAID" || bill.amountPaid > 0n) {
      throw new PayablesStateError(
        `Supplier bill ${bill.billNumber} has had ${bill.amountPaid.toString()} cents paid against it and cannot be cancelled: money has already left the business, so "this invoice never happened" is not true. The correction is a supplier credit note.`,
      );
    }

    if (bill.status === "AWAITING_PAYMENT") {
      if (bill.poId !== null) {
        await lockOrderForBilling(tx, schema, bill.poId);
      }

      const entry = await tx.journalEntry.findFirst({
        where: { source: "PURCHASE", sourceId: bill.id, status: "POSTED" },
        select: { id: true },
        orderBy: { entryNumber: "asc" },
      });
      if (entry === null) {
        throw new Error(
          `Supplier bill ${bill.billNumber} is ${bill.status} but no posted journal entry references it. Refusing to cancel: the ledger and the bill disagree, and that must be investigated rather than papered over.`,
        );
      }
      await reverseJournalEntryWithinTransaction(
        tx,
        schema,
        entry.id,
        `Cancelled supplier invoice ${bill.billNumber}: ${reason}`,
        cancelledById,
      );

      // Hand the billed quantity back, line by line.
      for (const line of bill.lines) {
        if (line.purchaseOrderLineId === null) {
          continue;
        }
        const poLine = await tx.purchaseOrderLine.findUniqueOrThrow({
          where: { id: line.purchaseOrderLineId },
          select: { id: true, billedQty: true, billedNet: true },
        });
        const billedMilli = decimalToMilli(poLine.billedQty.toString());
        const quantityMilli = decimalToMilli(line.quantity.toString());
        const nextMilli = billedMilli - quantityMilli;
        const nextNet = poLine.billedNet - line.lineNet;
        await tx.purchaseOrderLine.update({
          where: { id: poLine.id },
          data: {
            billedQty: milliToDecimalString(nextMilli > 0n ? nextMilli : 0n),
            billedNet: nextNet > 0n ? nextNet : 0n,
          },
        });
      }
    }

    const cancelled = await tx.supplierBill.update({
      where: { id: bill.id },
      data: { status: "CANCELLED" },
      include: BILL_INCLUDE,
    });
    return toBillRow(cancelled);
  });
}

// ---------------------------------------------------------------------------
// 5. RECORD A SUPPLIER PAYMENT
// ---------------------------------------------------------------------------

export interface PaymentAllocationInput {
  billId: string;
  amount: Cents;
}

export interface RecordSupplierPaymentInput {
  supplierId: string;
  paymentDate: Date;
  method: SupplierPaymentMethod;
  amount: Cents;
  reference?: string;
  notes?: string;
  allocations: PaymentAllocationInput[];
  createdById: string;
}

/**
 * RECORD A PAYMENT TO A SUPPLIER — ONE TRANSACTION.
 *
 *     Dr 2000 Accounts Payable      the debt being settled
 *     Cr 1000 / 1020 / 1010         the cash that left, by method
 *
 * EVERY SHILLING MUST BE ALLOCATED to a specific invoice, and the sum of the
 * allocations must equal the payment exactly. There is no on-account supplier
 * balance in this build: an unallocated payment would leave Accounts Payable
 * overstated while the aging report kept chasing a supplier who had been paid.
 * The service refuses it with a clear message and migration 0018's DEFERRED
 * constraint refuses it at COMMIT regardless of the caller.
 *
 * MPESA RECORDS, IT DOES NOT DISBURSE. There is no B2B payout here: this is the
 * record of money that went out through M-Pesa, and wiring up an actual
 * disbursement later is a new service over the existing per-tenant credential
 * store, not a change to this posting.
 */
export async function recordSupplierPayment(
  db: TenantPrismaClient,
  input: RecordSupplierPaymentInput,
): Promise<SupplierPaymentRow> {
  const schema = resolveSchema(db);

  if (input.amount <= 0n) {
    throw new PayablesValidationError("A payment amount must be positive.");
  }
  if (input.allocations.length === 0) {
    throw new PayablesValidationError(
      "A payment must be allocated to at least one bill: there is no on-account supplier balance, so every shilling has to be pointed at an invoice.",
    );
  }

  const allocationTotal = input.allocations.reduce((sum, a) => sum + a.amount, 0n);
  if (allocationTotal !== input.amount) {
    throw new PayablesValidationError(
      `The allocations total ${allocationTotal.toString()} cents but the payment is ${input.amount.toString()} cents. Every shilling of a payment must be allocated to a bill — an unallocated remainder would leave Accounts Payable overstated and the aging report chasing a supplier who has been paid.`,
    );
  }

  const seen = new Set<string>();
  for (const allocation of input.allocations) {
    if (allocation.amount <= 0n) {
      throw new PayablesValidationError("Every allocation amount must be positive.");
    }
    if (seen.has(allocation.billId)) {
      throw new PayablesValidationError(
        `Bill ${allocation.billId} appears twice in the allocations. Give one allocation per bill so that "how much of this payment settled that invoice" has a single answer.`,
      );
    }
    seen.add(allocation.billId);
  }

  return db.$transaction(async (tx) => {
    const supplier = await tx.supplier.findUnique({
      where: { id: input.supplierId },
      select: { id: true, name: true },
    });
    if (supplier === null) {
      throw new PayablesValidationError(`Unknown supplier ${input.supplierId}.`);
    }

    const paymentNumber = await nextPaymentNumber(tx, schema);
    const payment = await tx.supplierPayment.create({
      data: {
        paymentNumber,
        supplierId: supplier.id,
        paymentDate: input.paymentDate,
        method: input.method,
        amount: input.amount,
        ...(input.reference !== undefined ? { reference: input.reference } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        createdById: input.createdById,
      },
    });

    // Deterministic order so two concurrent payments touching the same pair of
    // bills take the row locks in the same sequence and cannot deadlock.
    const ordered = [...input.allocations].sort((a, b) => a.billId.localeCompare(b.billId));

    for (const allocation of ordered) {
      const bill = await lockBill(tx, schema, allocation.billId);
      if (bill.supplierId !== supplier.id) {
        throw new PayablesValidationError(
          `Bill ${bill.billNumber} belongs to a different supplier. A payment settles one supplier's invoices.`,
        );
      }
      if (bill.status === "DRAFT") {
        throw new PayablesStateError(
          `Supplier bill ${bill.billNumber} is still a DRAFT and has posted nothing to the ledger: it cannot be paid until it is posted.`,
        );
      }
      if (bill.status === "CANCELLED") {
        throw new PayablesStateError(
          `Supplier bill ${bill.billNumber} is CANCELLED and cannot be paid.`,
        );
      }
      if (bill.status === "PAID") {
        throw new PayablesStateError(
          `Supplier bill ${bill.billNumber} is already fully paid. Paying it again is the duplicate payment this module exists to prevent.`,
        );
      }

      const balance = bill.total - bill.amountPaid;
      if (allocation.amount > balance) {
        throw new PayablesValidationError(
          `Allocating ${allocation.amount.toString()} cents to bill ${bill.billNumber} would exceed its outstanding balance of ${balance.toString()} cents. A bill can never be paid more than it is for.`,
        );
      }

      const nextPaid = bill.amountPaid + allocation.amount;
      const nextStatus: SupplierBillStatus = nextPaid === bill.total ? "PAID" : "PARTIALLY_PAID";

      await tx.supplierPaymentAllocation.create({
        data: { paymentId: payment.id, billId: bill.id, amount: allocation.amount },
      });
      await tx.supplierBill.update({
        where: { id: bill.id },
        data: { amountPaid: nextPaid, status: nextStatus },
      });
    }

    await postJournalEntryWithinTransaction(tx, schema, {
      entryDate: input.paymentDate,
      description: `Supplier payment PAY-${paymentNumber.toString()} — ${supplier.name}`,
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
      source: "PURCHASE",
      sourceId: payment.id,
      createdBy: input.createdById,
      lines: [
        { accountCode: ACCT_AP, debit: input.amount, memo: `Settling ${supplier.name}` },
        {
          accountCode: PAYMENT_CREDIT_ACCOUNT[input.method],
          credit: input.amount,
          memo: `Paid by ${input.method}`,
        },
      ],
    });

    // Re-read the allocations so the returned ids are the real rows, not synthesised.
    const created = await tx.supplierPayment.findUniqueOrThrow({
      where: { id: payment.id },
      include: PAYMENT_INCLUDE,
    });
    return toPaymentRow(created);
  });
}

// ---------------------------------------------------------------------------
// 6. Reads — bills, payments
// ---------------------------------------------------------------------------

export interface ListSupplierBillFilters {
  status?: SupplierBillStatus;
  supplierId?: string;
  /** True: only bills past their due date with a balance outstanding. */
  overdue?: boolean;
  /** The day "overdue" is measured against. Defaults to today. */
  asOf?: Date;
}

export async function listSupplierBills(
  db: TenantPrismaClient,
  filters: ListSupplierBillFilters = {},
): Promise<SupplierBillRow[]> {
  // Overdue is judged on the BUSINESS day (Task H.1): dueDate is a date, so "now" is
  // cut to the day it is in Nairobi before the two are compared.
  const asOf = businessDateOf(filters.asOf ?? new Date());
  const bills = await db.supplierBill.findMany({
    where: {
      ...(filters.status !== undefined ? { status: filters.status } : {}),
      ...(filters.supplierId !== undefined ? { supplierId: filters.supplierId } : {}),
      // An overdue bill is one that is past due AND still owed. A PAID or
      // CANCELLED bill is never overdue however old it is.
      ...(filters.overdue === true
        ? { dueDate: { lt: asOf }, status: { in: ["AWAITING_PAYMENT", "PARTIALLY_PAID"] } }
        : {}),
    },
    include: BILL_INCLUDE,
    orderBy: [{ billDate: "desc" }, { createdAt: "desc" }],
  });
  return bills.map(toBillRow);
}

export interface SupplierBillDetail extends SupplierBillRow {
  /** The entry that posted this bill, once it has been posted. */
  journalEntryId: string | null;
}

export async function getSupplierBill(
  db: TenantPrismaClient,
  id: string,
): Promise<SupplierBillDetail | null> {
  const bill = await db.supplierBill.findUnique({ where: { id }, include: BILL_INCLUDE });
  if (bill === null) {
    return null;
  }
  // Derived rather than stored: the entry already carries `sourceId`, so a column
  // here would be a second copy of the same link that could fall out of step.
  const entry = await db.journalEntry.findFirst({
    where: { source: "PURCHASE", sourceId: bill.id },
    select: { id: true },
    orderBy: { entryNumber: "asc" },
  });
  return { ...toBillRow(bill), journalEntryId: entry?.id ?? null };
}

export async function listSupplierPayments(
  db: TenantPrismaClient,
  supplierId?: string,
): Promise<SupplierPaymentRow[]> {
  const payments = await db.supplierPayment.findMany({
    where: supplierId !== undefined ? { supplierId } : {},
    include: PAYMENT_INCLUDE,
    orderBy: { paymentNumber: "desc" },
  });
  return payments.map(toPaymentRow);
}

export async function getSupplierPayment(
  db: TenantPrismaClient,
  id: string,
): Promise<SupplierPaymentRow | null> {
  const payment = await db.supplierPayment.findUnique({ where: { id }, include: PAYMENT_INCLUDE });
  return payment === null ? null : toPaymentRow(payment);
}

// ---------------------------------------------------------------------------
// 7. AP AGING
// ---------------------------------------------------------------------------

export interface AgingBuckets {
  current: Cents;
  days1To30: Cents;
  days31To60: Cents;
  days61To90: Cents;
  over90: Cents;
}

export interface SupplierAgingRow extends AgingBuckets {
  supplierId: string;
  supplierName: string;
  total: Cents;
  billCount: number;
  oldestDueDate: Date | null;
}

export interface ApAgingReport {
  asOf: Date;
  suppliers: SupplierAgingRow[];
  totals: AgingBuckets;
  /**
   * The sum of every unpaid bill balance. **This figure is the AP movement this
   * module has posted to account 2000**, and the two reconciling is the acceptance
   * criterion for the whole task — see the engineering ledger "Accounts Payable".
   */
  grandTotal: Cents;
}

const MS_PER_DAY = 86_400_000;

function emptyBuckets(): AgingBuckets {
  return { current: 0n, days1To30: 0n, days31To60: 0n, days61To90: 0n, over90: 0n };
}

/**
 * Add a balance to the bucket its age falls in. Ages are whole days past the DUE
 * date, so a bill due today is `current` and one due yesterday is a day overdue.
 */
function addToBucket(buckets: AgingBuckets, daysOverdue: number, amount: Cents): void {
  if (daysOverdue <= 0) {
    buckets.current += amount;
  } else if (daysOverdue <= 30) {
    buckets.days1To30 += amount;
  } else if (daysOverdue <= 60) {
    buckets.days31To60 += amount;
  } else if (daysOverdue <= 90) {
    buckets.days61To90 += amount;
  } else {
    buckets.over90 += amount;
  }
}

/**
 * ACCOUNTS PAYABLE AGING, bucketed by DUE date over unpaid balances, per supplier.
 *
 * Only AWAITING_PAYMENT and PARTIALLY_PAID bills appear: a DRAFT has posted nothing
 * and is not a liability, a CANCELLED bill has been reversed, and a PAID one is
 * settled. Including any of them would make the report disagree with account 2000,
 * which is the one thing it must never do.
 *
 * It buckets by DUE date rather than invoice date on purpose — the question an
 * owner is asking is "what is late", and an invoice on 60-day terms issued 45 days
 * ago is not late.
 */
export async function getApAging(
  db: TenantPrismaClient,
  asOf: Date = new Date(),
): Promise<ApAgingReport> {
  const bills = await db.supplierBill.findMany({
    where: { status: { in: ["AWAITING_PAYMENT", "PARTIALLY_PAID"] } },
    select: {
      supplierId: true,
      dueDate: true,
      total: true,
      amountPaid: true,
      supplier: { select: { name: true } },
    },
    orderBy: { dueDate: "asc" },
  });

  // dueDate is a business DATE; age against the business day `asOf` falls on (Task
  // H.1), never against a UTC instant, which misread the evening hours as a day early.
  const asOfDay = businessDateOf(asOf);
  const bySupplier = new Map<string, SupplierAgingRow>();
  const totals = emptyBuckets();
  let grandTotal = 0n;

  for (const bill of bills) {
    const balance = bill.total - bill.amountPaid;
    if (balance <= 0n) {
      continue;
    }
    const daysOverdue = Math.floor((asOfDay.getTime() - bill.dueDate.getTime()) / MS_PER_DAY);

    let row = bySupplier.get(bill.supplierId);
    if (row === undefined) {
      row = {
        supplierId: bill.supplierId,
        supplierName: bill.supplier.name,
        total: 0n,
        billCount: 0,
        oldestDueDate: null,
        ...emptyBuckets(),
      };
      bySupplier.set(bill.supplierId, row);
    }

    addToBucket(row, daysOverdue, balance);
    addToBucket(totals, daysOverdue, balance);
    row.total += balance;
    row.billCount += 1;
    if (row.oldestDueDate === null || bill.dueDate < row.oldestDueDate) {
      row.oldestDueDate = bill.dueDate;
    }
    grandTotal += balance;
  }

  const suppliers = [...bySupplier.values()].sort((a, b) =>
    a.supplierName.localeCompare(b.supplierName),
  );
  return { asOf, suppliers, totals, grandTotal };
}

// ---------------------------------------------------------------------------
// 8. SUPPLIER STATEMENT
// ---------------------------------------------------------------------------

export type StatementEntryKind = "BILL" | "PAYMENT";

export interface SupplierStatementEntry {
  kind: StatementEntryKind;
  date: Date;
  reference: string;
  description: string;
  /** What the invoice added to what we owe. Zero on a payment row. */
  charged: Cents;
  /** What the payment took off. Zero on a bill row. */
  paid: Cents;
  /** The running amount owed after this entry. */
  runningBalance: Cents;
  billStatus: SupplierBillStatus | null;
  dueDate: Date | null;
}

export interface SupplierStatement {
  supplierId: string;
  supplierName: string;
  asOf: Date;
  entries: SupplierStatementEntry[];
  totalCharged: Cents;
  totalPaid: Cents;
  /**
   * `totalCharged - totalPaid`, which equals the sum of this supplier's unpaid bill
   * balances and therefore their slice of the aging report and of account 2000.
   */
  closingBalance: Cents;
}

/**
 * A SUPPLIER STATEMENT: every posted invoice and every payment, in date order, with
 * a running balance.
 *
 * CANCELLED bills are excluded, and so are DRAFTs. A cancelled bill's entry has
 * been REVERSED in the ledger, so showing the charge without the reversal would
 * make the statement's closing balance disagree with account 2000 — and the whole
 * value of a statement is that it reconciles.
 *
 * The running balance is accumulated in integer cents through the same BigInt
 * arithmetic as everything else; there is no floating point anywhere in it.
 */
export async function getSupplierStatement(
  db: TenantPrismaClient,
  supplierId: string,
  asOf: Date = new Date(),
): Promise<SupplierStatement | null> {
  const supplier = await db.supplier.findUnique({
    where: { id: supplierId },
    select: { id: true, name: true },
  });
  if (supplier === null) {
    return null;
  }

  const bills = await db.supplierBill.findMany({
    where: {
      supplierId,
      status: { in: ["AWAITING_PAYMENT", "PARTIALLY_PAID", "PAID"] },
      billDate: { lte: businessDateOf(asOf) },
    },
    select: { billNumber: true, billDate: true, dueDate: true, total: true, status: true },
  });
  const payments = await db.supplierPayment.findMany({
    where: { supplierId, paymentDate: { lte: businessDateOf(asOf) } },
    select: { paymentNumber: true, paymentDate: true, amount: true, method: true, reference: true },
  });

  const entries: SupplierStatementEntry[] = [
    ...bills.map((bill) => ({
      kind: "BILL" as const,
      date: bill.billDate,
      reference: bill.billNumber,
      description: `Invoice ${bill.billNumber}`,
      charged: bill.total,
      paid: 0n,
      runningBalance: 0n,
      billStatus: bill.status,
      dueDate: bill.dueDate,
    })),
    ...payments.map((payment) => ({
      kind: "PAYMENT" as const,
      date: payment.paymentDate,
      reference: payment.reference ?? `PAY-${payment.paymentNumber.toString()}`,
      description: `Payment PAY-${payment.paymentNumber.toString()} by ${payment.method}`,
      charged: 0n,
      paid: payment.amount,
      runningBalance: 0n,
      billStatus: null,
      dueDate: null,
    })),
  ];

  // Date order, and within a date invoices before payments: you are charged before
  // you settle, so a same-day invoice-and-payment pair reads correctly rather than
  // showing a transient negative balance.
  entries.sort((a, b) => {
    const byDate = a.date.getTime() - b.date.getTime();
    if (byDate !== 0) {
      return byDate;
    }
    if (a.kind !== b.kind) {
      return a.kind === "BILL" ? -1 : 1;
    }
    return a.reference.localeCompare(b.reference);
  });

  let running = 0n;
  let totalCharged = 0n;
  let totalPaid = 0n;
  for (const entry of entries) {
    running += entry.charged - entry.paid;
    entry.runningBalance = running;
    totalCharged += entry.charged;
    totalPaid += entry.paid;
  }

  return {
    supplierId: supplier.id,
    supplierName: supplier.name,
    asOf,
    entries,
    totalCharged,
    totalPaid,
    closingBalance: totalCharged - totalPaid,
  };
}
