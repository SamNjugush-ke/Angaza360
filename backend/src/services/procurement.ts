// ===========================================================================
// PROCUREMENT — PURCHASE ORDERS AND GOODS RECEIPTS (Module 4, Task 5.1).
//
// THIS IS THE ONLY MODULE PERMITTED TO WRITE `purchase_orders`,
// `purchase_order_lines` OR `goods_receipts`.
//
// IT WRITES NO STOCK TABLE AND POSTS NO JOURNAL ENTRY ITSELF. A receipt's stock
// and GL effects go through src/services/inventory.ts's transaction-participating
// mover — the SAME function the sale path, the allocation path and the write-off
// path use — inside ONE transaction with the GRN. So there is no second stock
// path, and the weighted-average cost, the location-ownership check and the
// Product.stockCount == SUM(per-location quantity) invariant are all INHERITED
// rather than reimplemented. This module decides WHETHER and WHAT; inventory.ts
// decides HOW stock and value move.
//
// ---------------------------------------------------------------------------
// WHAT A GOODS RECEIPT IS, FINANCIALLY
//
// Goods arrive with a DELIVERY NOTE, not a tax invoice. We owe the supplier, but:
//   * there is no invoiced amount to put in Accounts Payable — only a PO price;
//   * there is no tax invoice, so a VAT-registered tenant has nothing to claim
//     input VAT with.
// So a receipt accrues to 2050 GRNI (Goods Received Not Invoiced) and recognises
// no VAT. When the supplier's bill arrives (Task 5.2) GRNI clears to Accounts
// Payable, the input VAT is recognised, and any difference between the PO price
// and the invoiced price lands in 5250 Purchase Price Variance — so inventory
// keeps the cost it was received at instead of being silently restated.
//
// That is the entire reason GRNI exists: without it, either the books understate
// liabilities between delivery and invoice, or Accounts Payable carries a figure
// no supplier document supports.
// ---------------------------------------------------------------------------
// ===========================================================================

import type { PrismaClient as TenantPrismaClient } from "../generated/tenant/client";
import type { PurchaseOrderStatus } from "../generated/tenant/enums";
import { assertValidSchemaName, tenantSchemaFor } from "../db/tenant";
import { decimalToMilli, extendCost, milliToDecimalString } from "../lib/inventory-math";
import type { Cents } from "../lib/money";
import type { LedgerTx } from "./ledger";
import {
  recordStockMovementWithinTransaction,
  withInventoryErrorTranslation,
} from "./inventory";

/** Bad input (unknown supplier/product, non-positive quantity, empty PO). Route -> 400. */
export class ProcurementValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcurementValidationError";
  }
}

/** The PO's current state forbids the operation (editing an approved order). Route -> 409. */
export class ProcurementStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcurementStateError";
  }
}

function resolveSchema(db: TenantPrismaClient): string {
  const schema = tenantSchemaFor(db);
  assertValidSchemaName(schema);
  return schema;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface PurchaseOrderLineRow {
  id: string;
  productId: string;
  sku: string;
  productName: string;
  orderedQty: string;
  unitCost: Cents;
  lineNet: Cents;
  receivedQty: string;
  /** orderedQty - receivedQty: what is still expected. Never negative. */
  outstandingQty: string;
}

export interface PurchaseOrderRow {
  id: string;
  poNumber: number;
  supplierId: string;
  supplierName: string;
  status: PurchaseOrderStatus;
  orderDate: Date;
  expectedDate: Date | null;
  currency: string;
  subtotal: Cents;
  notes: string | null;
  createdById: string;
  approvedById: string | null;
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  lines: PurchaseOrderLineRow[];
}

const PO_INCLUDE = {
  supplier: { select: { name: true } },
  lines: {
    include: { product: { select: { sku: true, name: true } } },
    orderBy: { createdAt: "asc" },
  },
} as const;

interface RawLine {
  id: string;
  productId: string;
  orderedQty: { toString(): string };
  unitCost: bigint;
  lineNet: bigint;
  receivedQty: { toString(): string };
  product: { sku: string; name: string };
}

interface RawOrder {
  id: string;
  poNumber: number;
  supplierId: string;
  status: PurchaseOrderStatus;
  orderDate: Date;
  expectedDate: Date | null;
  currency: string;
  subtotal: bigint;
  notes: string | null;
  createdById: string;
  approvedById: string | null;
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  supplier: { name: string };
  lines: RawLine[];
}

function toLineRow(line: RawLine): PurchaseOrderLineRow {
  const orderedMilli = decimalToMilli(line.orderedQty.toString());
  const receivedMilli = decimalToMilli(line.receivedQty.toString());
  return {
    id: line.id,
    productId: line.productId,
    sku: line.product.sku,
    productName: line.product.name,
    // Normalised through the milli parser so every quantity in the API renders in
    // the same Decimal(14,3) form — a raw Decimal prints "10" where the rest of
    // the system prints "10.000".
    orderedQty: milliToDecimalString(orderedMilli),
    unitCost: line.unitCost,
    lineNet: line.lineNet,
    receivedQty: milliToDecimalString(receivedMilli),
    outstandingQty: milliToDecimalString(orderedMilli - receivedMilli),
  };
}

function toRow(order: RawOrder): PurchaseOrderRow {
  return {
    id: order.id,
    poNumber: order.poNumber,
    supplierId: order.supplierId,
    supplierName: order.supplier.name,
    status: order.status,
    orderDate: order.orderDate,
    expectedDate: order.expectedDate,
    currency: order.currency,
    subtotal: order.subtotal,
    notes: order.notes,
    createdById: order.createdById,
    approvedById: order.approvedById,
    approvedAt: order.approvedAt,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    lines: order.lines.map(toLineRow),
  };
}

// ---------------------------------------------------------------------------
// Line pricing — one definition, used by create and by edit
// ---------------------------------------------------------------------------

export interface PurchaseOrderLineInput {
  productId: string;
  /** Decimal(14,3) string. Must be positive. */
  quantity: string;
  /** Cost per unit in cents. NET for a VAT-registered tenant, VAT-INCLUSIVE otherwise. */
  unitCost: Cents;
}

interface PricedLine {
  productId: string;
  quantityMilli: bigint;
  unitCost: Cents;
  lineNet: Cents;
}

/**
 * Price the lines and total them.
 *
 * `extendCost` is the SAME primitive the sale path and every receipt use: the
 * quantity is held in thousandths and the product is rounded ONCE through
 * roundHalfUp. There is deliberately no second multiplication rule for purchase
 * orders — a PO line's value and the receipt's value must agree to the cent, and
 * the only way to guarantee that is to compute both the same way.
 */
async function priceLines(
  tx: LedgerTx,
  lines: ReadonlyArray<PurchaseOrderLineInput>,
): Promise<{ priced: PricedLine[]; subtotal: Cents }> {
  if (lines.length === 0) {
    throw new ProcurementValidationError("A purchase order needs at least one line.");
  }

  const seen = new Set<string>();
  const priced: PricedLine[] = [];
  let subtotal = 0n;

  for (const [index, line] of lines.entries()) {
    const position = index + 1;
    if (seen.has(line.productId)) {
      throw new ProcurementValidationError(
        `Line ${position.toString()}: product ${line.productId} appears twice. One line per product per order, so that "how much of this have we received" has a single answer.`,
      );
    }
    seen.add(line.productId);

    const product = await tx.product.findUnique({
      where: { id: line.productId },
      select: { id: true, isActive: true, sku: true },
    });
    if (product === null) {
      throw new ProcurementValidationError(
        `Line ${position.toString()}: unknown product ${line.productId}.`,
      );
    }
    if (!product.isActive) {
      throw new ProcurementValidationError(
        `Line ${position.toString()}: product ${product.sku} is inactive and cannot be ordered.`,
      );
    }

    const quantityMilli = decimalToMilli(line.quantity);
    if (quantityMilli <= 0n) {
      throw new ProcurementValidationError(
        `Line ${position.toString()}: quantity must be positive.`,
      );
    }
    if (line.unitCost < 0n) {
      throw new ProcurementValidationError(
        `Line ${position.toString()}: unitCost must not be negative.`,
      );
    }

    const lineNet = extendCost(quantityMilli, line.unitCost);
    subtotal += lineNet;
    priced.push({ productId: line.productId, quantityMilli, unitCost: line.unitCost, lineNet });
  }

  return { priced, subtotal };
}

/**
 * Allocate the next PO or GRN number from the tenant's own sequence.
 *
 * The same mechanism journal entry numbers use (migration 0003). Monotonic and
 * unique; not gap-free, because a sequence is non-transactional and a rolled-back
 * document burns its number. That trade is recorded in migration 0017: a gap in an
 * internal purchase-order number is harmless, two orders sharing one is not.
 *
 * Schema-qualified, because the pg adapter does not set search_path (the engineering ledger
 * "Raw SQL and Tenant Schema Resolution").
 */
async function nextNumber(
  tx: LedgerTx,
  schema: string,
  sequence: "purchase_order_number_seq" | "goods_receipt_number_seq",
): Promise<number> {
  assertValidSchemaName(schema);
  const rows = await tx.$queryRawUnsafe<Array<{ v: bigint }>>(
    `SELECT nextval('"${schema}"."${sequence}"') AS v`,
  );
  const first = rows[0];
  if (first === undefined) {
    throw new Error(`Failed to allocate a number from ${sequence}.`);
  }
  return Number(first.v);
}

// ---------------------------------------------------------------------------
// 1. CREATE — a DRAFT order. Commits nothing to the ledger.
// ---------------------------------------------------------------------------

export interface CreatePurchaseOrderInput {
  supplierId: string;
  orderDate: Date;
  expectedDate?: Date;
  notes?: string;
  lines: PurchaseOrderLineInput[];
  createdById: string;
}

/**
 * Create a DRAFT purchase order.
 *
 * A DRAFT HAS NO FINANCIAL EFFECT WHATSOEVER: no journal entry, no stock movement,
 * no commitment recorded anywhere but this table. An intention to buy is not a
 * transaction, and treating it as one is how systems end up with liabilities for
 * orders nobody ever placed.
 */
export async function createPurchaseOrder(
  db: TenantPrismaClient,
  input: CreatePurchaseOrderInput,
): Promise<PurchaseOrderRow> {
  const schema = resolveSchema(db);

  return db.$transaction(async (tx) => {
    const supplier = await tx.supplier.findUnique({ where: { id: input.supplierId } });
    if (supplier === null) {
      throw new ProcurementValidationError(`Unknown supplier ${input.supplierId}.`);
    }
    if (!supplier.isActive) {
      throw new ProcurementValidationError(
        `Supplier ${supplier.name} is inactive and cannot be ordered from.`,
      );
    }

    const { priced, subtotal } = await priceLines(tx, input.lines);
    const poNumber = await nextNumber(tx, schema, "purchase_order_number_seq");

    const created = await tx.purchaseOrder.create({
      data: {
        poNumber,
        supplierId: supplier.id,
        status: "DRAFT",
        orderDate: input.orderDate,
        expectedDate: input.expectedDate ?? null,
        subtotal,
        notes: input.notes ?? null,
        createdById: input.createdById,
        lines: {
          create: priced.map((line) => ({
            productId: line.productId,
            orderedQty: milliToDecimalString(line.quantityMilli),
            unitCost: line.unitCost,
            lineNet: line.lineNet,
          })),
        },
      },
      include: PO_INCLUDE,
    });
    return toRow(created);
  });
}

// ---------------------------------------------------------------------------
// 2. EDIT — DRAFT only
// ---------------------------------------------------------------------------

export interface UpdatePurchaseOrderInput {
  supplierId?: string;
  orderDate?: Date;
  expectedDate?: Date | null;
  notes?: string | null;
  /** Supplied => the line set is REPLACED wholesale. Omitted => lines untouched. */
  lines?: PurchaseOrderLineInput[];
}

/**
 * Edit a DRAFT order.
 *
 * REFUSED once the order leaves DRAFT, and the trigger in migration 0017 refuses
 * it too. The reason is not bookkeeping tidiness: once an order is APPROVED the
 * SUPPLIER HOLDS A COPY. Changing our side of a shared agreement without them does
 * not produce an edited order, it produces a discrepancy that surfaces when the
 * invoice disagrees with the PO.
 *
 * A supplied `lines` array REPLACES the whole line set rather than merging. A
 * partial merge would need a per-line identity the client does not have yet, and
 * guessing at one ("same product means same line") silently drops a quantity
 * change. Replacing is unambiguous, and a DRAFT has no received quantities to
 * preserve.
 */
export async function updatePurchaseOrder(
  db: TenantPrismaClient,
  id: string,
  input: UpdatePurchaseOrderInput,
): Promise<PurchaseOrderRow> {
  const schema = resolveSchema(db);

  return db.$transaction(async (tx) => {
    const existing = await lockOrder(tx, schema, id);
    if (existing.status !== "DRAFT") {
      throw new ProcurementStateError(
        `Purchase order ${existing.poNumber.toString()} is ${existing.status} and can no longer be edited. Only a DRAFT order is editable — the supplier holds a copy of an approved order.`,
      );
    }

    if (input.supplierId !== undefined && input.supplierId !== existing.supplierId) {
      const supplier = await tx.supplier.findUnique({ where: { id: input.supplierId } });
      if (supplier === null || !supplier.isActive) {
        throw new ProcurementValidationError(
          `Unknown or inactive supplier ${input.supplierId}.`,
        );
      }
    }

    let subtotal: Cents | undefined;
    if (input.lines !== undefined) {
      const { priced, subtotal: total } = await priceLines(tx, input.lines);
      subtotal = total;
      // Replace wholesale. Safe on a DRAFT: nothing has been received, so no
      // receivedQty is being discarded, and the line guard permits removal only
      // while the order is a DRAFT.
      await tx.purchaseOrderLine.deleteMany({ where: { poId: id } });
      for (const line of priced) {
        await tx.purchaseOrderLine.create({
          data: {
            poId: id,
            productId: line.productId,
            orderedQty: milliToDecimalString(line.quantityMilli),
            unitCost: line.unitCost,
            lineNet: line.lineNet,
          },
        });
      }
    }

    const updated = await tx.purchaseOrder.update({
      where: { id },
      data: {
        ...(input.supplierId !== undefined ? { supplierId: input.supplierId } : {}),
        ...(input.orderDate !== undefined ? { orderDate: input.orderDate } : {}),
        ...(input.expectedDate !== undefined ? { expectedDate: input.expectedDate } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(subtotal !== undefined ? { subtotal } : {}),
      },
      include: PO_INCLUDE,
    });
    return toRow(updated);
  });
}

// ---------------------------------------------------------------------------
// 3. APPROVE / CANCEL
// ---------------------------------------------------------------------------

/**
 * Approve a DRAFT order: it is now committed to the supplier and may be received
 * against. Still posts NOTHING — a commitment to buy is not a transaction, and
 * nothing hits the ledger until goods actually arrive.
 *
 * Single-step approval. Multi-level approval and budget checks are deferred; when
 * they arrive they add rows and a policy read, not a change to this transition.
 */
export async function approvePurchaseOrder(
  db: TenantPrismaClient,
  id: string,
  approvedById: string,
): Promise<PurchaseOrderRow> {
  const schema = resolveSchema(db);

  return db.$transaction(async (tx) => {
    const existing = await lockOrder(tx, schema, id);
    if (existing.status !== "DRAFT") {
      throw new ProcurementStateError(
        `Purchase order ${existing.poNumber.toString()} is ${existing.status}; only a DRAFT order can be approved.`,
      );
    }
    const lineCount = await tx.purchaseOrderLine.count({ where: { poId: id } });
    if (lineCount === 0) {
      throw new ProcurementValidationError(
        `Purchase order ${existing.poNumber.toString()} has no lines; there is nothing to approve.`,
      );
    }

    const updated = await tx.purchaseOrder.update({
      where: { id },
      data: { status: "APPROVED", approvedById, approvedAt: new Date() },
      include: PO_INCLUDE,
    });
    return toRow(updated);
  });
}

/**
 * Cancel an order that never happened.
 *
 * Permitted from DRAFT and APPROVED only. Once ANY goods have arrived the order
 * DID happen — value has been accrued to GRNI and the supplier will still invoice
 * it — so a partially-received order is CLOSED short instead, which says "we are
 * finished with this" without claiming it never occurred. The trigger in 0017
 * enforces the same thing.
 */
export async function cancelPurchaseOrder(
  db: TenantPrismaClient,
  id: string,
): Promise<PurchaseOrderRow> {
  const schema = resolveSchema(db);

  return db.$transaction(async (tx) => {
    const existing = await lockOrder(tx, schema, id);
    if (existing.status !== "DRAFT" && existing.status !== "APPROVED") {
      throw new ProcurementStateError(
        `Purchase order ${existing.poNumber.toString()} is ${existing.status} and cannot be cancelled. Goods have already been received against it, so the order did happen and value has been accrued to GRNI — close it short instead.`,
      );
    }
    const updated = await tx.purchaseOrder.update({
      where: { id },
      data: { status: "CANCELLED" },
      include: PO_INCLUDE,
    });
    return toRow(updated);
  });
}

/** Close an order: terminal, and permitted only once something has been received. */
export async function closePurchaseOrder(
  db: TenantPrismaClient,
  id: string,
): Promise<PurchaseOrderRow> {
  const schema = resolveSchema(db);

  return db.$transaction(async (tx) => {
    const existing = await lockOrder(tx, schema, id);
    if (existing.status !== "PARTIALLY_RECEIVED" && existing.status !== "RECEIVED") {
      throw new ProcurementStateError(
        `Purchase order ${existing.poNumber.toString()} is ${existing.status}; only a partially-received or fully-received order can be closed. An order with nothing received is cancelled instead.`,
      );
    }
    const updated = await tx.purchaseOrder.update({
      where: { id },
      data: { status: "CLOSED" },
      include: PO_INCLUDE,
    });
    return toRow(updated);
  });
}

// ---------------------------------------------------------------------------
// 4. RECEIVE — the one operation with a financial effect
// ---------------------------------------------------------------------------

export interface ReceiveLineInput {
  purchaseOrderLineId: string;
  /** Decimal(14,3) string. Positive, and never more than the line still expects. */
  quantity: string;
}

export interface ReceivePurchaseOrderInput {
  lines: ReceiveLineInput[];
  /** Where the goods land. Omitted resolves to the tenant's MAIN pool. */
  receivingLocationId?: string;
  receivedById: string;
  receivedAt?: Date;
  notes?: string;
}

export interface GoodsReceiptLineRow {
  purchaseOrderLineId: string;
  productId: string;
  sku: string;
  quantity: string;
  /** The cost this line accrued — the amount that reached 1200 and GRNI. */
  totalCost: Cents;
  stockMovementId: string;
  journalEntryId: string | null;
}

export interface GoodsReceiptRow {
  id: string;
  grnNumber: number;
  poId: string;
  poNumber: number;
  receivingLocationId: string;
  receivingLocationCode: string;
  receivedById: string;
  receivedAt: Date;
  notes: string | null;
  createdAt: Date;
  lines: GoodsReceiptLineRow[];
  /** The PO's status AFTER this receipt. */
  purchaseOrderStatus: PurchaseOrderStatus;
  /** Total accrued to 2050 GRNI by this receipt. */
  totalAccrued: Cents;
}

/**
 * RECEIVE GOODS AGAINST A PURCHASE ORDER — ONE TRANSACTION, ALL OF IT.
 *
 * In a single transaction this creates the GRN, moves the stock for every line,
 * posts the GL, advances each line's received quantity, and advances the order's
 * status. Either all of that commits or none of it does. The alternative — a GRN
 * saved before its stock moved, or stock moved before its liability was accrued —
 * would leave the books describing a receipt that only half happened.
 *
 * THE STOCK AND THE GL ARE NOT THIS MODULE'S WORK. Each line calls
 * recordStockMovementWithinTransaction, which is the same mover the sale path uses,
 * so the weighted-average cost update, the location-ownership check and the
 * aggregate invariant all apply exactly as they do everywhere else. Passing the
 * GRN and PO-line ids is what tells it to credit 2050 GRNI rather than Accounts
 * Payable and to recognise no VAT: a delivery note is not a tax invoice.
 *
 * OVER-RECEIPT is refused here with a message naming the line and what it still
 * expects, and refused again by the CHECK on the line. Both exist deliberately:
 * the service check is ergonomics, the constraint is the invariant.
 */
export async function receivePurchaseOrder(
  db: TenantPrismaClient,
  poId: string,
  input: ReceivePurchaseOrderInput,
): Promise<GoodsReceiptRow> {
  const schema = resolveSchema(db);
  if (input.lines.length === 0) {
    throw new ProcurementValidationError("A goods receipt needs at least one line.");
  }

  const receivedAt = input.receivedAt ?? new Date();

  return withInventoryErrorTranslation(() =>
    db.$transaction(async (tx) => {
      const order = await lockOrder(tx, schema, poId);
      if (order.status !== "APPROVED" && order.status !== "PARTIALLY_RECEIVED") {
        throw new ProcurementStateError(
          `Purchase order ${order.poNumber.toString()} is ${order.status}; goods may only be received against an APPROVED or PARTIALLY_RECEIVED order.`,
        );
      }

      // Where the goods land. Omitted resolves to MAIN, exactly as the sale path
      // defaults its selling location — so stock always arrives somewhere specific
      // and the location-ownership rules apply from the moment it lands.
      const location =
        input.receivingLocationId === undefined
          ? await tx.location.findFirst({ where: { isDefault: true } })
          : await tx.location.findUnique({ where: { id: input.receivingLocationId } });
      if (location === null) {
        throw new ProcurementValidationError(
          input.receivingLocationId === undefined
            ? "No default (MAIN) location is configured for this tenant, so goods have nowhere to land."
            : `Unknown location ${input.receivingLocationId}.`,
        );
      }
      if (!location.isActive) {
        throw new ProcurementValidationError(
          `Location ${location.code} is deactivated and cannot receive goods.`,
        );
      }

      // Validate every line BEFORE anything is written, so a bad second line does
      // not leave a half-built receipt to roll back.
      const seen = new Set<string>();
      const planned: Array<{ line: RawLine; quantityMilli: bigint }> = [];
      for (const [index, requested] of input.lines.entries()) {
        const position = index + 1;
        if (seen.has(requested.purchaseOrderLineId)) {
          throw new ProcurementValidationError(
            `Receipt line ${position.toString()}: purchase order line ${requested.purchaseOrderLineId} appears twice in one receipt. Combine them into a single quantity.`,
          );
        }
        seen.add(requested.purchaseOrderLineId);

        const line = order.lines.find((candidate) => candidate.id === requested.purchaseOrderLineId);
        if (line === undefined) {
          throw new ProcurementValidationError(
            `Receipt line ${position.toString()}: purchase order line ${requested.purchaseOrderLineId} does not belong to order ${order.poNumber.toString()}.`,
          );
        }

        const quantityMilli = decimalToMilli(requested.quantity);
        if (quantityMilli <= 0n) {
          throw new ProcurementValidationError(
            `Receipt line ${position.toString()}: quantity must be positive.`,
          );
        }
        const orderedMilli = decimalToMilli(line.orderedQty.toString());
        const receivedMilli = decimalToMilli(line.receivedQty.toString());
        const outstandingMilli = orderedMilli - receivedMilli;
        if (quantityMilli > outstandingMilli) {
          throw new ProcurementValidationError(
            `Receipt line ${position.toString()} (${line.product.sku}): cannot receive ${milliToDecimalString(quantityMilli)} — the order still expects only ${milliToDecimalString(outstandingMilli)} of ${milliToDecimalString(orderedMilli)}. Receiving more than was ordered would accrue a liability for goods nobody ordered.`,
          );
        }
        planned.push({ line, quantityMilli });
      }

      const grnNumber = await nextNumber(tx, schema, "goods_receipt_number_seq");
      const grn = await tx.goodsReceipt.create({
        data: {
          grnNumber,
          poId: order.id,
          receivingLocationId: location.id,
          receivedById: input.receivedById,
          receivedAt,
          notes: input.notes ?? null,
        },
      });

      const reference = `GRN-${grnNumber.toString()}`;
      const resultLines: GoodsReceiptLineRow[] = [];
      let totalAccrued = 0n;

      for (const { line, quantityMilli } of planned) {
        // THE STOCK AND GL EFFECT, performed by the inventory service. The GRN and
        // PO-line ids select the GRNI posting and are stamped on the movement so
        // Task 5.2 can match a bill to what actually arrived.
        const movement = await recordStockMovementWithinTransaction(tx, schema, {
          productId: line.productId,
          movementType: "PURCHASE_RECEIPT",
          quantity: milliToDecimalString(quantityMilli),
          unitCost: line.unitCost,
          supplierId: order.supplierId,
          reference,
          createdBy: input.receivedById,
          entryDate: receivedAt,
          locationId: location.id,
          goodsReceiptId: grn.id,
          purchaseOrderLineId: line.id,
        });

        const receivedMilli = decimalToMilli(line.receivedQty.toString());
        await tx.purchaseOrderLine.update({
          where: { id: line.id },
          data: { receivedQty: milliToDecimalString(receivedMilli + quantityMilli) },
        });

        totalAccrued += movement.totalCost;
        resultLines.push({
          purchaseOrderLineId: line.id,
          productId: line.productId,
          sku: line.product.sku,
          quantity: milliToDecimalString(quantityMilli),
          totalCost: movement.totalCost,
          stockMovementId: movement.id,
          journalEntryId: movement.journalEntryId,
        });
      }

      // Advance the order. Re-read the lines rather than reasoning from the plan:
      // the authoritative answer to "is this order fully received" is what the rows
      // now say, not what this call intended them to say.
      const after = await tx.purchaseOrderLine.findMany({
        where: { poId: order.id },
        select: { orderedQty: true, receivedQty: true },
      });
      const fullyReceived = after.every(
        (line) =>
          decimalToMilli(line.receivedQty.toString()) >=
          decimalToMilli(line.orderedQty.toString()),
      );
      const nextStatus: PurchaseOrderStatus = fullyReceived ? "RECEIVED" : "PARTIALLY_RECEIVED";
      await tx.purchaseOrder.update({ where: { id: order.id }, data: { status: nextStatus } });

      return {
        id: grn.id,
        grnNumber: grn.grnNumber,
        poId: order.id,
        poNumber: order.poNumber,
        receivingLocationId: location.id,
        receivingLocationCode: location.code,
        receivedById: grn.receivedById,
        receivedAt: grn.receivedAt,
        notes: grn.notes,
        createdAt: grn.createdAt,
        lines: resultLines,
        purchaseOrderStatus: nextStatus,
        totalAccrued,
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// 5. Reads
// ---------------------------------------------------------------------------

export interface ListPurchaseOrderFilters {
  status?: PurchaseOrderStatus;
  supplierId?: string;
}

export async function listPurchaseOrders(
  db: TenantPrismaClient,
  filters: ListPurchaseOrderFilters = {},
): Promise<PurchaseOrderRow[]> {
  const orders = await db.purchaseOrder.findMany({
    where: {
      ...(filters.status !== undefined ? { status: filters.status } : {}),
      ...(filters.supplierId !== undefined ? { supplierId: filters.supplierId } : {}),
    },
    include: PO_INCLUDE,
    orderBy: { poNumber: "desc" },
  });
  return orders.map(toRow);
}

export async function getPurchaseOrder(
  db: TenantPrismaClient,
  id: string,
): Promise<PurchaseOrderRow | null> {
  const order = await db.purchaseOrder.findUnique({ where: { id }, include: PO_INCLUDE });
  return order === null ? null : toRow(order);
}

export async function getGoodsReceipt(
  db: TenantPrismaClient,
  id: string,
): Promise<GoodsReceiptRow | null> {
  const grn = await db.goodsReceipt.findUnique({
    where: { id },
    include: {
      order: { select: { poNumber: true, status: true } },
      receivingLocation: { select: { code: true } },
      movements: {
        include: { product: { select: { sku: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (grn === null) {
    return null;
  }

  let totalAccrued = 0n;
  const lines: GoodsReceiptLineRow[] = grn.movements.map((movement) => {
    totalAccrued += movement.totalCost;
    return {
      purchaseOrderLineId: movement.purchaseOrderLineId ?? "",
      productId: movement.productId,
      sku: movement.product.sku,
      // The movement's signed quantity is positive for an inbound receipt; render
      // it in the same Decimal(14,3) form as every other quantity.
      quantity: milliToDecimalString(decimalToMilli(movement.quantity.toString())),
      totalCost: movement.totalCost,
      stockMovementId: movement.id,
      journalEntryId: movement.journalEntryId,
    };
  });

  return {
    id: grn.id,
    grnNumber: grn.grnNumber,
    poId: grn.poId,
    poNumber: grn.order.poNumber,
    receivingLocationId: grn.receivingLocationId,
    receivingLocationCode: grn.receivingLocation.code,
    receivedById: grn.receivedById,
    receivedAt: grn.receivedAt,
    notes: grn.notes,
    createdAt: grn.createdAt,
    lines,
    purchaseOrderStatus: grn.order.status,
    totalAccrued,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Load an order with its lines under a ROW LOCK.
 *
 * The lock is what makes concurrent receipts against the same order safe: two
 * deliveries booked at the same instant serialise on the order row, so each sees
 * the other's received quantities and the second cannot over-receive against a
 * stale reading. The CHECK on the line is the backstop behind the lock.
 */
async function lockOrder(tx: LedgerTx, schema: string, id: string): Promise<RawOrder> {
  assertValidSchemaName(schema);
  const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT "id" FROM "${schema}".purchase_orders WHERE "id" = $1 FOR UPDATE`,
    id,
  );
  if (locked[0] === undefined) {
    throw new ProcurementValidationError(`Unknown purchase order ${id}.`);
  }
  const order = await tx.purchaseOrder.findUnique({ where: { id }, include: PO_INCLUDE });
  if (order === null) {
    throw new ProcurementValidationError(`Unknown purchase order ${id}.`);
  }
  return order;
}
