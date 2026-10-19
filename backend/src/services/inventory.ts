// ===========================================================================
// Inventory & Product Catalog Engine (Module 2 + procurement, Task 3.1;
// location-owned stock, Task 10.1).
//
// THIS IS THE ONLY MODULE PERMITTED TO WRITE stock_movements OR
// product_location_stock, OR TO MUTATE Product.stockCount / Product.stockValue
// / Product.avgCost. Every valued movement posts a balanced journal entry
// through the ledger service in the SAME transaction, so stock and the general
// ledger move atomically and can never diverge. This module never writes
// journal tables directly and never mutates an account balance.
//
// STOCK IS LOCATION-OWNED (Task 10.1). Two tables, one truth:
//   * stock_movements        — the IMMUTABLE HISTORY of every change.
//   * product_location_stock — the CURRENT-BALANCE PROJECTION: what each
//                              location OWNS right now.
// The invariant maintained by every path below is:
//     Product.stockCount == SUM(product_location_stock.quantity for a product)
// Both sides are written inside ONE transaction, always. A movement with no
// explicit location resolves to the tenant's default MAIN location, so the
// pre-location world keeps behaving exactly as it did.
//
// An OUTBOUND movement is checked against the SOURCE LOCATION's SELLABLE
// quantity, not merely against the tenant aggregate: nothing sells stock it does
// not own.
//
// FROZEN STOCK (Task OFF.1). product_location_stock also carries
// `frozenQuantity`: the portion of what a location owns that an expired,
// unsynced lease has immobilised. SELLABLE = quantity - frozenQuantity, and that
// is the figure every outbound movement and every transfer source is checked
// against. Freezing changes NOTHING else — not `quantity`, not
// Product.stockCount/stockValue/avgCost, not the ledger — so the aggregate
// invariant and sum(Product.stockValue) = GL(1200) are untouched by it, and a
// freeze posts no journal entry because no value entered or left the entity.
// This module owns that column exactly as it owns `quantity`; the offline freeze
// service decides WHEN, never HOW.
//
// PURCHASE RECEIPTS NOW BRANCH ON THE TENANT'S VAT STATUS AND ON WHETHER THERE
// IS A PURCHASE ORDER (Task 5.1) — see purchaseReceiptMapping below for the four
// cases. What does NOT change is the valuation: `totalCost` is still the single
// figure that moves Product.stockValue AND reaches account 1200, so a GRNI credit
// or a recoverable-VAT debit is an extra line in the same balanced entry and never
// a second opinion about what the stock is worth.
//
// VALUATION IS CARRYING-VALUE-AUTHORITATIVE (Task 3.1-FIX). Product.stockValue
// is the authoritative monetary figure and moves ONLY by the exact delta a
// movement posts. It is never recomputed as stockCount * avgCost — avgCost is a
// DERIVED cache of stockValue / stockCount and may never rebuild the value it
// came from. Each movement computes ONE monetary figure and that identical
// figure becomes (a) the stockValue delta, (b) the movement's totalCost, and
// (c) the amount posted to the general ledger. Because those three are one
// number, sum(Product.stockValue) = GL balance of account 1200 is structural
// rather than something that has to keep coming out even.
// ===========================================================================

import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient as TenantPrismaClient } from "../generated/tenant/client";
import type { JournalSource, ProductType, StockMovementType } from "../generated/tenant/enums";
import { assertValidSchemaName, tenantSchemaFor } from "../db/tenant";
import { applyRatePercent, type Cents } from "../lib/money";
import {
  decimalToMilli,
  deriveAvgCost,
  displayAvgCost,
  extendCost,
  formatAvgCost,
  milliToDecimalString,
  proportionalCost,
} from "../lib/inventory-math";
import {
  postJournalEntryWithinTransaction,
  PeriodClosedError,
  LedgerValidationError,
  type JournalLineInput,
  type LedgerTx,
} from "./ledger";
import { isVatRegisteredWithinTransaction } from "./business-profile";
import { appliedVatRate, kraTaxCode } from "../lib/vat";
import { noVatRateMessage, resolveStandardVatRate } from "./tax-config";

/**
 * 2050 GRNI — received-not-invoiced clearing (Task 5.1). Only a goods receipt
 * credits it and only a supplier bill (Task 5.2) debits it. No sale, void,
 * transfer, write-off or adjustment may reach it, which is why it appears exactly
 * once in this file, in the purchase-receipt mapping.
 */
const ACCT_GRNI = "2050";

/** 1400 VAT Input (Recoverable) — debited only by an ad-hoc receipt for a VAT-registered tenant. */
const ACCT_VAT_INPUT = "1400";

/**
 * What the purchase-receipt posting branch needs to know. Resolved ONCE per
 * movement, immediately before the entry is built, and only for the movement type
 * that uses it — every other type ignores it entirely.
 */
interface PurchaseReceiptContext {
  /** The tenant's VAT status, from the business-profile singleton. */
  isVatRegistered: boolean;
  /** The product's own tax rate as a decimal string. A RATE, never money. */
  vatRate: string;
  /** true when this receipt fulfils a purchase-order line (a GRN). */
  againstPurchaseOrder: boolean;
}

// ---- error types the route layer maps to HTTP codes ----

/** Bad input (unknown product, missing cost, zero quantity, etc.). Route -> 400. */
export class InventoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryValidationError";
  }
}

/** A movement would drive stock below zero. Route -> 400. */
export class InsufficientStockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientStockError";
  }
}

// Inbound types carry a positive signed quantity; outbound a negative one.
const INBOUND_TYPES = new Set<StockMovementType>([
  "PURCHASE_RECEIPT",
  "SALE_RETURN",
  "ADJUSTMENT_INCREASE",
  "TRANSFER_IN",
  "OPENING_BALANCE",
]);
const OUTBOUND_TYPES = new Set<StockMovementType>([
  "SALE",
  "PURCHASE_RETURN",
  "ADJUSTMENT_DECREASE",
  "WRITE_OFF",
  "TRANSFER_OUT",
]);

/** Refuses a stock operation on a SERVICE product (Task T-A8): it carries no stock. */
function assertStockedProduct(product: { sku: string; kind: ProductType }): void {
  if (product.kind === "SERVICE") {
    throw new InventoryValidationError(
      `Product ${product.sku} is a SERVICE and carries no stock: it cannot be received, moved, transferred or written off.`,
    );
  }
}

// The movements a DEACTIVATED product refuses (Task T-A7): selling it, and bringing
// new stock in. Everything that only moves or retires stock it already holds stays open.
const DEACTIVATED_PRODUCT_REFUSED = new Set<StockMovementType>([
  "SALE",
  "PURCHASE_RECEIPT",
  "ADJUSTMENT_INCREASE",
  "OPENING_BALANCE",
]);

// ---------------------------------------------------------------------------
// GL MAPPING PER MOVEMENT TYPE.
//
// `null` = no posting at all (value stays within the entity — an inter-location
// transfer). Otherwise the mapping produces the ENTRY'S LINES. Most movements are
// a plain two-line Dr/Cr for the movement's totalCost; a purchase receipt is the
// one that can need three, because a VAT-registered tenant recovers input VAT.
//
// WHAT NEVER CHANGES, whatever the shape: `totalCost` is the amount that reaches
// ACCOUNT 1200, and it is the same bigint that moves Product.stockValue. The
// VALUATION EVENT IS UNTOUCHED BY ANY OF THIS (Task 3.1-FIX) — a VAT line or a
// GRNI credit is an additional line in the same balanced entry, never a second
// figure for the stock to be valued at.
// ---------------------------------------------------------------------------
interface GlMapping {
  lines: JournalLineInput[];
  source: JournalSource;
}

/** Shorthand for the two-line Dr/Cr that every non-receipt movement posts. */
function simpleEntry(
  debit: string,
  credit: string,
  amount: Cents,
  source: JournalSource,
): GlMapping {
  return {
    lines: [
      { accountCode: debit, debit: amount },
      { accountCode: credit, credit: amount },
    ],
    source,
  };
}

/**
 * THE PURCHASE-RECEIPT POSTING MODEL (Task 5.1). Four cases, two questions:
 * was there a PURCHASE ORDER, and is the tenant VAT-REGISTERED?
 *
 * The PO question is really "is there a tax invoice in hand yet?". A goods receipt
 * against a PO arrives with a delivery note, not an invoice: we owe the supplier
 * but have nothing to claim VAT with and no invoiced amount to put in Accounts
 * Payable. So it accrues to 2050 GRNI and recognises NO VAT. An ad-hoc receipt is
 * booked from an invoice already in hand, so it goes straight to AP and recovers
 * the VAT immediately.
 *
 *   (A) PO receipt, VAT-REGISTERED      Dr 1200 net        / Cr 2050 GRNI net
 *   (B) PO receipt, NON-registered      Dr 1200 inclusive  / Cr 2050 GRNI inclusive
 *   (C) ad-hoc, VAT-REGISTERED          Dr 1200 net
 *                                       Dr 1400 VAT Input net*rate
 *                                                          / Cr 2000 AP gross
 *   (D) ad-hoc, NON-registered          Dr 1200 cost       / Cr 2000 AP cost
 *
 * (D) IS BYTE-IDENTICAL TO THE PRE-5.1 BEHAVIOUR, and both existing tenants are
 * non-registered, so nothing about any existing ledger changes until an owner
 * says otherwise.
 *
 * `paidImmediately` swaps the AP credit for cash in the ad-hoc cases, exactly as
 * before. It has no meaning for a PO receipt: paying a supplier is Task 5.2's
 * settlement step, and a GRN cannot be "paid" because nothing has been invoiced.
 *
 * WHY INVENTORY CARRIES A DIFFERENT FIGURE FOR THE TWO REGIMES, stated plainly
 * because it looks like an inconsistency and is not: for a registered business the
 * VAT it pays on a purchase is recoverable from KRA, so it is a receivable, not a
 * cost of the goods. For a non-registered business that same VAT is never coming
 * back, so it IS part of what the goods cost. Capitalising it in one case and not
 * the other is what makes gross margin true in both.
 */
function purchaseReceiptMapping(
  totalCost: Cents,
  vatRate: string,
  isVatRegistered: boolean,
  againstPurchaseOrder: boolean,
  paidImmediately: boolean,
): GlMapping {
  if (againstPurchaseOrder) {
    // (A) and (B). totalCost is net for a registered tenant and inclusive for a
    // non-registered one, because that is what the PO's unitCost means in each
    // case — so the two branches are one line of code, and the difference lives
    // where the convention is documented rather than in a second posting rule.
    return simpleEntry("1200", ACCT_GRNI, totalCost, "PURCHASE");
  }

  if (!isVatRegistered) {
    // (D) — unchanged from before this task.
    return simpleEntry("1200", paidImmediately ? "1000" : "2000", totalCost, "PURCHASE");
  }

  // (C). The one three-line entry in this file. The VAT is computed from the
  // movement's own cost through the SINGLE rate primitive the sale path uses, so
  // input and output VAT can never round differently.
  const vat = applyRatePercent(totalCost, vatRate);
  const lines: JournalLineInput[] = [{ accountCode: "1200", debit: totalCost }];
  if (vat > 0n) {
    lines.push({ accountCode: ACCT_VAT_INPUT, debit: vat });
  }
  lines.push({
    accountCode: paidImmediately ? "1000" : "2000",
    credit: totalCost + vat,
  });
  return { lines, source: "PURCHASE" };
}

function glMappingFor(
  type: StockMovementType,
  paidImmediately: boolean,
  amount: Cents,
  context: PurchaseReceiptContext,
): GlMapping | null {
  switch (type) {
    case "PURCHASE_RECEIPT":
      return purchaseReceiptMapping(
        amount,
        context.vatRate,
        context.isVatRegistered,
        context.againstPurchaseOrder,
        paidImmediately,
      );
    case "PURCHASE_RETURN":
      return simpleEntry("2000", "1200", amount, "PURCHASE");
    case "SALE":
      // Cost side only; the revenue side belongs to the POS sale (Task 3.2).
      return simpleEntry("5000", "1200", amount, "POS");
    case "SALE_RETURN":
      return simpleEntry("1200", "5000", amount, "SALE_RETURN");
    case "WRITE_OFF":
      return simpleEntry("5300", "1200", amount, "INVENTORY_ADJUSTMENT");
    case "ADJUSTMENT_INCREASE":
      return simpleEntry("1200", "5300", amount, "INVENTORY_ADJUSTMENT");
    case "ADJUSTMENT_DECREASE":
      return simpleEntry("5300", "1200", amount, "INVENTORY_ADJUSTMENT");
    case "OPENING_BALANCE":
      return simpleEntry("1200", "3000", amount, "OPENING_BALANCE");
    case "TRANSFER_IN":
    case "TRANSFER_OUT":
      return null;
    default: {
      // Exhaustiveness guard — a new movement type must declare its mapping.
      const exhaustive: never = type;
      throw new Error(`No GL mapping declared for movement type ${String(exhaustive)}.`);
    }
  }
}

export interface RecordStockMovementInput {
  productId: string;
  movementType: StockMovementType;
  quantity: string; // positive magnitude as a decimal string; the service applies the sign
  unitCost?: Cents; // required for inbound types; ignored for outbound (the derived rate is used)
  /**
   * REVERSALS ONLY. The exact cost the movement being reversed originally
   * posted, snapshotted on its source document (e.g. SaleLine.lineCogs). When
   * present on an inbound movement it IS the valuation event: stockValue, the
   * movement's totalCost and the journal entry all take this figure, instead of
   * re-extending `unitCost` and landing a cent or two away from what came out.
   * That is what makes a sale and its void net account 1200 to exactly zero.
   * Ignored on outbound movements, which are valued out of the carrying value.
   */
  reversalTotalCost?: Cents;
  supplierId?: string;
  reference?: string;
  notes?: string;
  createdBy: string;
  paidImmediately?: boolean; // PURCHASE_RECEIPT: credit Cash instead of Accounts Payable
  entryDate?: Date; // GL entry date; defaults to today
  locationId?: string; // defaults to the tenant's default (MAIN) location when absent

  /**
   * PROCUREMENT LINKS (Task 5.1). Supplied together by the procurement service
   * when a PURCHASE_RECEIPT fulfils a purchase-order line, and by nothing else.
   *
   * Their PRESENCE is what selects the GRNI posting: a receipt against a PO
   * arrives with a delivery note and no tax invoice, so it accrues to 2050 and
   * recognises no VAT. Their absence means an ad-hoc receipt booked from an
   * invoice in hand, which goes to Accounts Payable and recovers VAT if the tenant
   * is registered. The two must come as a pair — a CHECK in migration 0017
   * enforces that on the stored movement.
   */
  goodsReceiptId?: string;
  purchaseOrderLineId?: string;
}

export interface StockMovementResult {
  id: string;
  productId: string;
  movementType: StockMovementType;
  quantity: string; // signed decimal string
  unitCost: Cents;
  /** THE valuation event: the stockValue delta, this figure, and the GL amount are one number. */
  totalCost: Cents;
  balanceQty: string; // decimal string
  balanceValue: Cents;
  avgCostAfter: Cents;
  /** The derived rate after the movement, to six decimal places of a cent (not money — a rate). */
  avgCostAfterPrecise: string;
  supplierId: string | null;
  reference: string | null;
  notes: string | null;
  journalEntryId: string | null;
  locationId: string | null;
  /** The GRN this movement was part of, when it came from a purchase order (Task 5.1). */
  goodsReceiptId: string | null;
  /** The PO line it fulfilled. Paired with goodsReceiptId or both are null. */
  purchaseOrderLineId: string | null;
  createdBy: string;
  createdAt: Date;
}

function resolveSchema(db: TenantPrismaClient): string {
  const schema = tenantSchemaFor(db);
  assertValidSchemaName(schema);
  return schema;
}

/**
 * Run `fn` and translate the database's own rejections into the typed inventory
 * errors the route layer maps to HTTP codes. Exported so a caller that composes
 * an inventory operation into its OWN transaction (the allocation service, Task
 * 10.2) reports a CHECK-constraint rejection with the same message and the same
 * status code as a direct inventory call — one translation table, not two.
 */
export async function withInventoryErrorTranslation<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (
      error instanceof InventoryValidationError ||
      error instanceof InsufficientStockError ||
      error instanceof PeriodClosedError ||
      error instanceof LedgerValidationError
    ) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/product_stock_non_negative/.test(message)) {
      throw new InsufficientStockError(
        "Movement rejected: it would drive stock or stock value negative.",
      );
    }
    if (/product_location_stock_non_negative/.test(message)) {
      throw new InsufficientStockError(
        "Movement rejected: it would drive a location's owned stock negative.",
      );
    }
    if (/requires a (positive|negative) quantity|must be non-zero/.test(message)) {
      throw new InventoryValidationError(message);
    }
    throw error;
  }
}

interface DerivedMovement {
  magnitudeMilli: bigint;
  signedQtyMilli: bigint;
  inbound: boolean;
}

// ---------------------------------------------------------------------------
// Per-location owned stock (Task 10.1). These two helpers are the ONLY places
// product_location_stock is written, and both run inside a caller-owned
// transaction so the slice and the aggregate always commit together.
// ---------------------------------------------------------------------------

/**
 * What a location holds for one product: the total it OWNS and the portion that
 * is FROZEN (immobilised by an expired lease, Task OFF.1).
 *
 *     SELLABLE = ownedMilli - frozenMilli
 *
 * Every outbound movement and every transfer source is checked against SELLABLE,
 * never against the raw owned figure: frozen stock is still the tenant's stock
 * and still carried in Product.stockValue, but the server does not know whether
 * an offline device already sold it, so it must not move again until the freeze
 * resolves.
 */
interface LocationHolding {
  ownedMilli: bigint;
  frozenMilli: bigint;
}

function sellableMilli(holding: LocationHolding): bigint {
  return holding.ownedMilli - holding.frozenMilli;
}

/**
 * Read a location's holding for a product, taking a row lock so two concurrent
 * movements against the same slice serialise. Returns zeroes when the location
 * has no row yet (it owns nothing, which is not an error).
 *
 * The row lock is a schema-qualified raw statement because the pg adapter does
 * not set search_path (see the engineering ledger "Raw SQL and Tenant Schema Resolution").
 */
async function lockLocationHolding(
  tx: LedgerTx,
  schema: string,
  productId: string,
  locationId: string,
): Promise<LocationHolding> {
  const rows = await tx.$queryRawUnsafe<
    Array<{ quantity: Prisma.Decimal; frozenQuantity: Prisma.Decimal }>
  >(
    `SELECT "quantity", "frozenQuantity" FROM "${schema}".product_location_stock
      WHERE "productId" = $1 AND "locationId" = $2
      FOR UPDATE`,
    productId,
    locationId,
  );
  const row = rows[0];
  if (row === undefined) {
    return { ownedMilli: 0n, frozenMilli: 0n };
  }
  return {
    ownedMilli: decimalToMilli(row.quantity),
    frozenMilli: decimalToMilli(row.frozenQuantity),
  };
}

/**
 * Apply a signed delta to a location's owned quantity, creating the row if the
 * location did not hold this product before. The caller has already locked the
 * product row (and, for a decrement, the slice), so the read-modify-write here
 * is safe. The DB's non-negative CHECK is the backstop.
 */
async function applyLocationDelta(
  tx: LedgerTx,
  schema: string,
  productId: string,
  locationId: string,
  currentMilli: bigint,
  deltaMilli: bigint,
): Promise<void> {
  const nextMilli = currentMilli + deltaMilli;
  await tx.$executeRawUnsafe(
    `INSERT INTO "${schema}".product_location_stock
       ("id", "productId", "locationId", "quantity", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4::numeric, now(), now())
     ON CONFLICT ("productId", "locationId")
     DO UPDATE SET "quantity" = EXCLUDED."quantity", "updatedAt" = now()`,
    randomUUID(),
    productId,
    locationId,
    milliToDecimalString(nextMilli),
  );
}

function validateAndDeriveMovement(input: RecordStockMovementInput): DerivedMovement {
  const magnitudeMilli = decimalToMilli(input.quantity);
  if (magnitudeMilli <= 0n) {
    throw new InventoryValidationError("quantity must be a positive magnitude.");
  }

  const inbound = INBOUND_TYPES.has(input.movementType);
  const outbound = OUTBOUND_TYPES.has(input.movementType);
  if (!inbound && !outbound) {
    throw new InventoryValidationError(`Unsupported movement type ${input.movementType}.`);
  }

  if (inbound) {
    if (input.unitCost === undefined) {
      throw new InventoryValidationError(
        `${input.movementType} is an inbound movement and requires a unitCost.`,
      );
    }
    if (input.unitCost < 0n) {
      throw new InventoryValidationError("unitCost must not be negative.");
    }
  }

  if ((input.goodsReceiptId === undefined) !== (input.purchaseOrderLineId === undefined)) {
    throw new InventoryValidationError(
      "goodsReceiptId and purchaseOrderLineId must be supplied together: a movement either came from a purchase order (both) or it did not (neither).",
    );
  }
  if (input.goodsReceiptId !== undefined && input.movementType !== "PURCHASE_RECEIPT") {
    throw new InventoryValidationError(
      `Only a PURCHASE_RECEIPT may reference a goods receipt; ${input.movementType} cannot.`,
    );
  }

  if (input.reversalTotalCost !== undefined) {
    if (!inbound) {
      throw new InventoryValidationError(
        "reversalTotalCost applies only to inbound movements; an outbound movement is valued out of the carrying value.",
      );
    }
    if (input.reversalTotalCost < 0n) {
      throw new InventoryValidationError("reversalTotalCost must not be negative.");
    }
  }

  return { magnitudeMilli, signedQtyMilli: inbound ? magnitudeMilli : -magnitudeMilli, inbound };
}

// The core movement, run against an already-open transaction. Does NOT manage
// the transaction. Used both by the standalone entry point and by callers (POS)
// that need the movement to participate in their own transaction.
async function recordStockMovementCore(
  tx: LedgerTx,
  schema: string,
  input: RecordStockMovementInput,
  derived: DerivedMovement,
  entryDate: Date,
): Promise<StockMovementResult> {
  const { magnitudeMilli, signedQtyMilli, inbound } = derived;

  // 1. Lock the product row FIRST, before reading stockCount, so two concurrent
  // movements of the last unit cannot both proceed. The FOR UPDATE is a
  // schema-qualified raw statement (the adapter does not set search_path).
  const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM "${schema}".products WHERE id = $1 FOR UPDATE`,
    input.productId,
  );
  if (locked[0] === undefined) {
    throw new InventoryValidationError(`Unknown product ${input.productId}.`);
  }

  const product = await tx.product.findUnique({ where: { id: input.productId } });
  if (product === null) {
    throw new InventoryValidationError(`Unknown product ${input.productId}.`);
  }
  // A SERVICE carries no stock (Task T-A8): it has nothing to receive, hold, count or
  // deplete, so EVERY movement for it is refused here — the
  // `product_service_carries_no_stock` CHECK is the guarantee behind this.
  assertStockedProduct(product);
  // A DEACTIVATED product (Task T-A7) can be neither sold nor restocked. Its stock
  // stays owned and valued, so moving what it already holds — a transfer, a write-off,
  // an adjustment down, a void's SALE_RETURN — is still allowed.
  if (!product.isActive && DEACTIVATED_PRODUCT_REFUSED.has(input.movementType)) {
    throw new InventoryValidationError(
      `Product ${product.sku} is deactivated: it cannot be sold or restocked (${input.movementType}). Reactivate it first.`,
    );
  }

  // Resolve the location: a supplied id must exist and be active; otherwise the
  // tenant's default (MAIN) location is used, so every movement is stamped
  // without any caller having to pass one.
  let locationId: string;
  let locationCode: string;
  if (input.locationId !== undefined) {
    const location = await tx.location.findUnique({ where: { id: input.locationId } });
    if (location === null || !location.isActive) {
      throw new InventoryValidationError(`Unknown or inactive location ${input.locationId}.`);
    }
    locationId = location.id;
    locationCode = location.code;
  } else {
    const defaultLocation = await tx.location.findFirst({ where: { isDefault: true } });
    if (defaultLocation === null) {
      throw new InventoryValidationError("No default location is configured for this tenant.");
    }
    locationId = defaultLocation.id;
    locationCode = defaultLocation.code;
  }

  // Lock this location's slice and read what it currently OWNS, and how much of
  // that is FROZEN. An outbound movement is checked against THIS location's
  // SELLABLE figure, not merely the tenant aggregate: a till may not sell stock
  // that sits in another location, and it may not sell stock immobilised by an
  // unresolved lease freeze.
  const holding = await lockLocationHolding(tx, schema, product.id, locationId);
  const locationQtyMilli = holding.ownedMilli;

  const existingQtyMilli = decimalToMilli(product.stockCount);
  const existingStockValue = product.stockValue;

  const newQtyMilli = existingQtyMilli + signedQtyMilli;
  if (newQtyMilli < 0n) {
    throw new InsufficientStockError(
      `Insufficient stock for ${product.sku} (${product.name}): requested ${milliToDecimalString(magnitudeMilli)}, available ${milliToDecimalString(existingQtyMilli)}.`,
    );
  }

  // The location-level check, against what this location may actually SELL. It
  // can only bite when the tenant HAS the stock but this location cannot use it
  // — because another location owns it, or because an unresolved lease freeze has
  // immobilised it. Before any non-MAIN location exists, MAIN owns everything
  // unfrozen and this is equivalent to the aggregate check above.
  if (!inbound) {
    const sellable = sellableMilli(holding);
    if (magnitudeMilli > sellable) {
      throw new InsufficientStockError(
        holding.frozenMilli > 0n
          ? `Insufficient sellable stock for ${product.sku} (${product.name}) at location ${locationCode}: requested ${milliToDecimalString(magnitudeMilli)}, owned ${milliToDecimalString(locationQtyMilli)} of which ${milliToDecimalString(holding.frozenMilli)} is FROZEN pending reconciliation of an expired lease, leaving ${milliToDecimalString(sellable)} sellable.`
          : `Insufficient stock for ${product.sku} (${product.name}) at location ${locationCode}: requested ${milliToDecimalString(magnitudeMilli)}, owned ${milliToDecimalString(locationQtyMilli)}.`,
      );
    }
  }

  // ---- THE SINGLE VALUATION EVENT (Task 3.1-FIX) -------------------------
  //
  // Exactly one monetary figure is computed here. It becomes the stockValue
  // delta, the movement's totalCost, and the amount posted to the ledger — the
  // same bigint in all three places, so they cannot disagree by a rounding.
  //
  //   INBOUND   costDelta = quantity * the caller's EXPLICIT unitCost. A
  //             receipt states its own cost, so this is exact by definition.
  //             (A reversal instead replays the exact figure it is undoing.)
  //   OUTBOUND  PARTIAL   — the aggregate stays above zero: the quantity's
  //             proportional share of the carrying value, apportioned with the
  //             rate held exact and rounded once.
  //             DEPLETING — the aggregate reaches exactly zero: the ENTIRE
  //             remaining stockValue. Zero quantity must leave zero value; a
  //             proportional share would leave a ghost balance of a cent or two
  //             against an empty shelf.
  //
  // The depletion rule keys on the AGGREGATE, never on a location emptying: a
  // till running out while the warehouse still holds stock is an ordinary
  // partial movement, because the product still carries value.
  let totalCost: Cents;
  if (inbound) {
    totalCost =
      input.reversalTotalCost !== undefined
        ? input.reversalTotalCost
        : extendCost(magnitudeMilli, input.unitCost as Cents);
  } else if (newQtyMilli === 0n) {
    totalCost = existingStockValue;
  } else {
    totalCost = proportionalCost(magnitudeMilli, existingQtyMilli, existingStockValue);
  }

  // The authoritative carrying value moves by the posted delta. It is NEVER
  // recomputed from a quantity and a rate — that recomputation was the defect.
  const newStockValue = inbound
    ? existingStockValue + totalCost
    : existingStockValue - totalCost;

  // The rate recorded ON THIS MOVEMENT is its own effective per-unit cost
  // (totalCost / quantity), which for a depleting movement is honestly not the
  // running average. unitCost is a display/audit figure here; totalCost is the
  // number that moved.
  const unitCost: Cents = inbound
    ? (input.unitCost as Cents)
    : displayAvgCost(deriveAvgCost(totalCost, magnitudeMilli));

  // avgCost is REDERIVED from the two authoritative figures — a cache refresh,
  // never an input to anything above.
  const newAvgCostMicro = deriveAvgCost(newStockValue, newQtyMilli);
  const newAvgCost: Cents = displayAvgCost(newAvgCostMicro);

  // 7. Post the GL entry (if any) in THIS transaction so stock and ledger
  // commit together. If it throws (including PeriodClosedError) the whole
  // transaction rolls back and no stock moves.
  const movementId = randomUUID();

  // The purchase-receipt branch is the only one that needs the tenant's VAT
  // status, so the profile is read only for it — one small indexed read on a
  // receipt, and nothing at all on a sale line, which is the hot path.
  //
  // THE RECOVERABLE RATE IS CLASS-DERIVED (Task 3B.1), by the same rule the sale path
  // uses: only a standard-rated product carries input VAT, at the standard rate in
  // force on the receipt's date. A zero-rated or exempt product carries none — its
  // supplier charged none — and a non-registered tenant recovers none.
  const receiptIsVatRegistered =
    input.movementType === "PURCHASE_RECEIPT" ? await isVatRegisteredWithinTransaction(tx) : false;
  let receiptVatRate = "0.00";
  if (receiptIsVatRegistered) {
    const code = kraTaxCode(product.taxClass, true);
    if (code === "B") {
      const resolved = await resolveStandardVatRate(tx, entryDate);
      if (resolved === null) {
        throw new InventoryValidationError(noVatRateMessage(entryDate));
      }
      receiptVatRate = appliedVatRate(code, resolved.rate);
    }
  }
  const receiptContext: PurchaseReceiptContext = {
    isVatRegistered: receiptIsVatRegistered,
    vatRate: receiptVatRate,
    againstPurchaseOrder: input.goodsReceiptId !== undefined,
  };

  const mapping = glMappingFor(
    input.movementType,
    input.paidImmediately ?? false,
    totalCost,
    receiptContext,
  );
  let journalEntryId: string | null = null;
  if (mapping !== null && totalCost > 0n) {
    const entry = await postJournalEntryWithinTransaction(tx, schema, {
      entryDate,
      description: `${input.movementType} ${product.sku} x ${milliToDecimalString(magnitudeMilli)}`,
      reference: input.reference,
      source: mapping.source,
      sourceId: movementId,
      createdBy: input.createdBy,
      lines: mapping.lines,
    });
    journalEntryId = entry.id;
  }

  // Insert the movement row (sign trigger validates the signed quantity).
  const movement = await tx.stockMovement.create({
    data: {
      id: movementId,
      productId: product.id,
      movementType: input.movementType,
      quantity: milliToDecimalString(signedQtyMilli),
      unitCost,
      totalCost,
      balanceQty: milliToDecimalString(newQtyMilli),
      balanceValue: newStockValue,
      avgCostAfter: newAvgCost,
      supplierId: input.supplierId ?? null,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      journalEntryId,
      locationId,
      goodsReceiptId: input.goodsReceiptId ?? null,
      purchaseOrderLineId: input.purchaseOrderLineId ?? null,
      createdBy: input.createdBy,
    },
  });

  // 6. Update the product's live balances (CHECK constraint enforces >= 0).
  await tx.product.update({
    where: { id: product.id },
    data: {
      stockCount: milliToDecimalString(newQtyMilli),
      stockValue: newStockValue,
      avgCost: newAvgCost,
    },
  });

  // 6b. Move the SAME quantity on this location's owned slice, in this same
  // transaction. Aggregate and slice change together or not at all, which is
  // what keeps stockCount == SUM(location quantities) true after every movement.
  await applyLocationDelta(
    tx,
    schema,
    product.id,
    locationId,
    locationQtyMilli,
    signedQtyMilli,
  );

  return {
    id: movement.id,
    productId: movement.productId,
    movementType: movement.movementType,
    quantity: movement.quantity.toString(),
    unitCost: movement.unitCost,
    totalCost: movement.totalCost,
    balanceQty: movement.balanceQty.toString(),
    balanceValue: movement.balanceValue,
    avgCostAfter: movement.avgCostAfter,
    avgCostAfterPrecise: formatAvgCost(newAvgCostMicro),
    supplierId: movement.supplierId,
    reference: movement.reference,
    notes: movement.notes,
    journalEntryId: movement.journalEntryId,
    locationId: movement.locationId,
    goodsReceiptId: movement.goodsReceiptId,
    purchaseOrderLineId: movement.purchaseOrderLineId,
    createdBy: movement.createdBy,
    createdAt: movement.createdAt,
  };
}

export async function recordStockMovement(
  db: TenantPrismaClient,
  input: RecordStockMovementInput,
): Promise<StockMovementResult> {
  const schema = resolveSchema(db);
  const derived = validateAndDeriveMovement(input);
  const entryDate = input.entryDate ?? new Date();

  return withInventoryErrorTranslation(() =>
    db.$transaction((tx) => recordStockMovementCore(tx, schema, input, derived, entryDate)),
  );
}

// Record a stock movement INSIDE a transaction the caller already opened (e.g. a
// POS sale), so stock, COGS, and the sale row all commit atomically. The caller
// passes the resolved, validated tenant schema and owns the transaction and its
// error translation. Typed errors (InsufficientStockError, PeriodClosedError)
// throw synchronously and roll the caller's transaction back.
export async function recordStockMovementWithinTransaction(
  tx: LedgerTx,
  schema: string,
  input: RecordStockMovementInput,
): Promise<StockMovementResult> {
  assertValidSchemaName(schema);
  const derived = validateAndDeriveMovement(input);
  const entryDate = input.entryDate ?? new Date();
  return recordStockMovementCore(tx, schema, input, derived, entryDate);
}

// ===========================================================================
// TRANSFERS — moving owned stock between locations (Task 10.1)
//
// A transfer is VALUE-NEUTRAL and that is the whole point:
//   * it posts NO journal entry — no value enters or leaves the entity, the
//     same goods are simply held somewhere else;
//   * Product.stockCount (the tenant aggregate) is UNCHANGED;
//   * Product.stockValue and Product.avgCost are UNCHANGED;
//   * ONLY the per-location split moves.
// A transfer that touched the ledger would in fact BREAK the invariant
// sum(Product.stockValue) = GL balance of 1200, because 1200 would move while
// the inventory total did not. See the engineering ledger "Stock Is Location-Owned".
//
// It is still fully AUDITABLE: two immutable stock_movements are written, a
// TRANSFER_OUT on the source and a TRANSFER_IN on the destination, both with
// journalEntryId = null (consistent with glMappingFor returning null for the
// TRANSFER types since Task 3.1).
// ===========================================================================

export interface TransferStockInput {
  productId: string;
  fromLocationId: string;
  toLocationId: string;
  quantity: string; // positive magnitude as a decimal string
  reference?: string;
  notes?: string;
  createdBy: string;
}

export interface TransferStockResult {
  productId: string;
  sku: string;
  quantity: string;
  fromLocationId: string;
  fromLocationCode: string;
  fromQuantityAfter: string;
  toLocationId: string;
  toLocationCode: string;
  toQuantityAfter: string;
  /** Unchanged by a transfer — echoed so a caller can see that it did not move. */
  productStockCount: string;
  /** The derived tenant-wide rate, rounded to cents. Unchanged by a transfer. */
  avgCost: Cents;
  /** The same rate to six decimal places of a cent. Not money — a rate. */
  avgCostPrecise: string;
  /**
   * The transferred quantity's proportional share of the carrying value, for
   * the audit rows only. A transfer posts NO journal entry and does not move
   * Product.stockValue.
   */
  valueMoved: Cents;
  outMovementId: string;
  inMovementId: string;
  createdAt: Date;
}

function validateTransferInput(input: TransferStockInput): bigint {
  const magnitudeMilli = decimalToMilli(input.quantity);
  if (magnitudeMilli <= 0n) {
    throw new InventoryValidationError("quantity must be a positive magnitude.");
  }
  if (input.fromLocationId === input.toLocationId) {
    throw new InventoryValidationError(
      "fromLocationId and toLocationId must be different locations.",
    );
  }
  return magnitudeMilli;
}

// The core transfer, run against an already-open transaction. Does NOT manage
// the transaction — mirroring recordStockMovementCore, so a caller that must
// move stock AND write its own row atomically (Task 10.2's allocation approval)
// participates in ONE transaction rather than inventing a second stock path.
async function transferStockCore(
  tx: LedgerTx,
  schema: string,
  input: TransferStockInput,
  magnitudeMilli: bigint,
): Promise<TransferStockResult> {
  // Lock the PRODUCT row first — always, and before either slice. Two
  // concurrent transfers of the same product (even in opposite directions)
  // therefore serialise on one row and cannot deadlock against each other.
  const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM "${schema}".products WHERE id = $1 FOR UPDATE`,
    input.productId,
  );
  if (locked[0] === undefined) {
    throw new InventoryValidationError(`Unknown product ${input.productId}.`);
  }

  const product = await tx.product.findUnique({ where: { id: input.productId } });
  if (product === null) {
    throw new InventoryValidationError(`Unknown product ${input.productId}.`);
  }
  assertStockedProduct(product);

  const from = await tx.location.findUnique({ where: { id: input.fromLocationId } });
  if (from === null || !from.isActive) {
    throw new InventoryValidationError(
      `Unknown or inactive source location ${input.fromLocationId}.`,
    );
  }
  const to = await tx.location.findUnique({ where: { id: input.toLocationId } });
  if (to === null || !to.isActive) {
    throw new InventoryValidationError(
      `Unknown or inactive destination location ${input.toLocationId}.`,
    );
  }

  const fromHolding = await lockLocationHolding(tx, schema, product.id, from.id);
  const toHolding = await lockLocationHolding(tx, schema, product.id, to.id);
  const fromQtyMilli = fromHolding.ownedMilli;
  const toQtyMilli = toHolding.ownedMilli;

  // The source must OWN what it is sending, AND that stock must be SELLABLE —
  // not immobilised by an unresolved lease freeze. Naming the available quantity
  // makes the error actionable at a till.
  //
  // Refusing to transfer FROZEN stock out is the operational form of "the server
  // never guesses what an offline device sold": an admin moving a frozen till's
  // stock back to MAIN by hand would be making exactly the auto-return decision
  // the engineering ledger forbids, and could oversell goods the device had already sold. The
  // two legitimate exits are a late sync and a write-off.
  const fromSellable = sellableMilli(fromHolding);
  if (fromSellable < magnitudeMilli) {
    throw new InsufficientStockError(
      fromHolding.frozenMilli > 0n
        ? `Insufficient sellable stock at source location ${from.code} for ${product.sku} (${product.name}): requested ${milliToDecimalString(magnitudeMilli)}, owned ${milliToDecimalString(fromQtyMilli)} of which ${milliToDecimalString(fromHolding.frozenMilli)} is FROZEN pending reconciliation of an expired lease, leaving ${milliToDecimalString(fromSellable)} transferable. Resolve the freeze (the device syncs, or an admin writes it off) rather than moving the stock by hand.`
        : `Insufficient stock at source location ${from.code} for ${product.sku} (${product.name}): requested ${milliToDecimalString(magnitudeMilli)}, available ${milliToDecimalString(fromQtyMilli)}.`,
    );
  }

  // Nor may stock be transferred INTO a location that holds frozen stock for
  // this product. The destination's frozenQuantity was set to everything it
  // owned at the moment of the freeze, so new stock arriving there would be
  // sellable on a dead lease — a device that reconnects could sell it without
  // ever having had custody of it.
  if (toHolding.frozenMilli > 0n) {
    throw new InsufficientStockError(
      `Destination location ${to.code} holds ${milliToDecimalString(toHolding.frozenMilli)} of ${product.sku} FROZEN pending reconciliation of an expired lease. Resolve the freeze before allocating more stock there — otherwise the new stock would be sellable on a dead lease.`,
    );
  }

  const aggregateQtyMilli = decimalToMilli(product.stockCount);

  // Value moved, for the audit rows only — the transferred quantity's
  // proportional share of the carrying value. Product.stockValue and the
  // derived avgCost are NOT recomputed and NOT written: a transfer neither
  // buys nor sells anything, so there is no valuation event, no ledger
  // posting, and no change to the tenant-wide figures.
  const valueMoved = proportionalCost(
    magnitudeMilli,
    aggregateQtyMilli,
    product.stockValue,
  );
  const rateMicro = deriveAvgCost(product.stockValue, aggregateQtyMilli);
  const displayRate = displayAvgCost(rateMicro);

  const fromAfterMilli = fromQtyMilli - magnitudeMilli;
  const toAfterMilli = toQtyMilli + magnitudeMilli;

  // Two immutable movements. balanceQty/balanceValue/avgCostAfter record the
  // TENANT-WIDE figures, which a transfer leaves untouched — the history
  // therefore shows plainly that the aggregate did not move.
  const outMovement = await tx.stockMovement.create({
    data: {
      id: randomUUID(),
      productId: product.id,
      movementType: "TRANSFER_OUT",
      quantity: milliToDecimalString(-magnitudeMilli),
      unitCost: displayRate,
      totalCost: valueMoved,
      balanceQty: milliToDecimalString(aggregateQtyMilli),
      balanceValue: product.stockValue,
      avgCostAfter: displayRate,
      supplierId: null,
      reference: input.reference ?? null,
      notes: input.notes ?? `Transfer ${from.code} -> ${to.code}`,
      journalEntryId: null,
      locationId: from.id,
      // A transfer is not a purchase: no GRN, no PO line.
      goodsReceiptId: null,
      purchaseOrderLineId: null,
      createdBy: input.createdBy,
    },
  });

  const inMovement = await tx.stockMovement.create({
    data: {
      id: randomUUID(),
      productId: product.id,
      movementType: "TRANSFER_IN",
      quantity: milliToDecimalString(magnitudeMilli),
      unitCost: displayRate,
      totalCost: valueMoved,
      balanceQty: milliToDecimalString(aggregateQtyMilli),
      balanceValue: product.stockValue,
      avgCostAfter: displayRate,
      supplierId: null,
      reference: input.reference ?? null,
      notes: input.notes ?? `Transfer ${from.code} -> ${to.code}`,
      journalEntryId: null,
      locationId: to.id,
      goodsReceiptId: null,
      purchaseOrderLineId: null,
      createdBy: input.createdBy,
    },
  });

  // Move the slice. Note what is NOT here: no tx.product.update(), because
  // the aggregate does not move, and no ledger call, because no value moved.
  await applyLocationDelta(tx, schema, product.id, from.id, fromQtyMilli, -magnitudeMilli);
  await applyLocationDelta(tx, schema, product.id, to.id, toQtyMilli, magnitudeMilli);

  return {
    productId: product.id,
    sku: product.sku,
    quantity: milliToDecimalString(magnitudeMilli),
    fromLocationId: from.id,
    fromLocationCode: from.code,
    fromQuantityAfter: milliToDecimalString(fromAfterMilli),
    toLocationId: to.id,
    toLocationCode: to.code,
    toQuantityAfter: milliToDecimalString(toAfterMilli),
    productStockCount: milliToDecimalString(aggregateQtyMilli),
    avgCost: displayRate,
    avgCostPrecise: formatAvgCost(rateMicro),
    valueMoved,
    outMovementId: outMovement.id,
    inMovementId: inMovement.id,
    createdAt: outMovement.createdAt,
  };
}

export async function transferStock(
  db: TenantPrismaClient,
  input: TransferStockInput,
): Promise<TransferStockResult> {
  const schema = resolveSchema(db);
  const magnitudeMilli = validateTransferInput(input);

  return withInventoryErrorTranslation(() =>
    db.$transaction((tx) => transferStockCore(tx, schema, input, magnitudeMilli)),
  );
}

/**
 * Transfer owned stock INSIDE a transaction the caller already opened, so the
 * transfer and the caller's own row commit atomically — the allocation-approval
 * path (Task 10.2) flips an AllocationRequest to APPROVED and moves the stock in
 * ONE transaction through this entry point.
 *
 * This exists precisely SO THAT the allocation service does not need a second
 * way to move stock: src/services/inventory.ts remains the sole writer of
 * stock_movements and product_location_stock. The caller passes the resolved,
 * validated tenant schema and owns the transaction and its error translation;
 * typed errors (InsufficientStockError, InventoryValidationError) throw
 * synchronously and roll the caller's transaction back, moving nothing.
 */
export async function transferStockWithinTransaction(
  tx: LedgerTx,
  schema: string,
  input: TransferStockInput,
): Promise<TransferStockResult> {
  assertValidSchemaName(schema);
  const magnitudeMilli = validateTransferInput(input);
  return transferStockCore(tx, schema, input, magnitudeMilli);
}

// ===========================================================================
// FREEZING AND THAWING A LOCATION'S STOCK (Task OFF.1)
//
// A lease expired without the device syncing, so the server does not know what
// the device sold. The location's remaining owned stock is IMMOBILISED: removed
// from its sellable allocation, NOT returned to MAIN's sellable pool.
//
// WHAT A FREEZE DOES NOT DO, and this is the important part:
//   * it posts NO JOURNAL ENTRY — no value entered or left the entity; the goods
//     are still the tenant's, just immobilised, so there is nothing to post and
//     sum(Product.stockValue) = GL(1200) keeps holding;
//   * it writes NO stock_movements row — nothing physically moved anywhere;
//   * it leaves Product.stockCount, stockValue and avgCost untouched;
//   * it leaves product_location_stock.quantity untouched, so the invariant
//     Product.stockCount == SUM(quantity) is unaffected.
// It moves exactly one thing: how much of what the location owns is SELLABLE.
//
// These two functions are HERE, in the sole writer of product_location_stock,
// for the same reason transferStockWithinTransaction is: the freeze service
// decides WHEN stock freezes, and this module is the only thing permitted to
// touch a stock column. src/services/offline/freeze.ts writes no stock table.
// ===========================================================================

export interface FrozenSliceRow {
  productId: string;
  sku: string;
  name: string;
  /** The immobilised quantity at this location. */
  frozenQuantity: string;
  /** Total owned at this location (frozen included) — unchanged by the freeze. */
  ownedQuantity: string;
}

interface FrozenSliceRawRow {
  product_id: string;
  sku: string;
  product_name: string;
  frozen_quantity: string;
  owned_quantity: string;
}

function mapFrozenSlice(row: FrozenSliceRawRow): FrozenSliceRow {
  return {
    productId: row.product_id,
    sku: row.sku,
    name: row.product_name,
    frozenQuantity: milliToDecimalString(decimalToMilli(row.frozen_quantity)),
    ownedQuantity: milliToDecimalString(decimalToMilli(row.owned_quantity)),
  };
}

const FROZEN_SLICE_COLUMNS = `pls."productId"          AS product_id,
          p."sku"                  AS sku,
          p."name"                 AS product_name,
          pls."frozenQuantity"::text AS frozen_quantity,
          pls."quantity"::text     AS owned_quantity`;

/**
 * Immobilise everything a location still owns, inside the caller's transaction.
 * Sets frozenQuantity := quantity on every slice the location holds a positive
 * quantity of, and returns what was frozen.
 *
 * Idempotent in effect: a slice already fully frozen is set to the same value.
 * Slices holding zero are skipped — freezing nothing is not a freeze.
 */
export async function freezeLocationStockWithinTransaction(
  tx: LedgerTx,
  schema: string,
  locationId: string,
): Promise<FrozenSliceRow[]> {
  assertValidSchemaName(schema);

  // Lock the slices first so a concurrent sale cannot slip between the read and
  // the freeze. The UPDATE itself takes the same locks, so this is the ordering
  // guarantee rather than a second trip.
  const rows = await tx.$queryRawUnsafe<FrozenSliceRawRow[]>(
    `UPDATE "${schema}".product_location_stock pls
        SET "frozenQuantity" = pls."quantity", "updatedAt" = now()
      FROM "${schema}".products p
      WHERE p."id" = pls."productId"
        AND pls."locationId" = $1
        AND pls."quantity" > 0
      RETURNING ${FROZEN_SLICE_COLUMNS}`,
    locationId,
  );
  return rows.map(mapFrozenSlice).sort((a, b) => a.sku.localeCompare(b.sku));
}

/**
 * Release the immobilisation on a location's slices, inside the caller's
 * transaction: frozenQuantity := 0. The stock becomes sellable again.
 *
 * This is NOT a resolution on its own. It is the mechanical step the two real
 * resolutions take first — a late sync (which then posts the device's real sales
 * out of this stock and transfers the genuine remainder back to MAIN) and an
 * admin write-off (which then posts the loss) — each of which does it inside the
 * SAME transaction as the rest of its work, so there is no window in which a dead
 * lease's stock is quietly sellable.
 */
export async function thawLocationStockWithinTransaction(
  tx: LedgerTx,
  schema: string,
  locationId: string,
): Promise<number> {
  assertValidSchemaName(schema);
  return tx.$executeRawUnsafe(
    `UPDATE "${schema}".product_location_stock
        SET "frozenQuantity" = 0, "updatedAt" = now()
      WHERE "locationId" = $1 AND "frozenQuantity" <> 0`,
    locationId,
  );
}

/** What a location currently holds frozen. Read-only; used by the offline reads. */
export async function getFrozenStockAtLocation(
  db: TenantPrismaClient,
  locationId: string,
): Promise<FrozenSliceRow[]> {
  const schema = resolveSchema(db);
  const rows = await db.$queryRawUnsafe<FrozenSliceRawRow[]>(
    `SELECT ${FROZEN_SLICE_COLUMNS}
     FROM "${schema}".product_location_stock pls
     JOIN "${schema}".products p ON p."id" = pls."productId"
     WHERE pls."locationId" = $1 AND pls."frozenQuantity" > 0
     ORDER BY p."sku" ASC`,
    locationId,
  );
  return rows.map(mapFrozenSlice);
}

/**
 * Write a location's FROZEN stock off as an inventory loss, inside the caller's
 * transaction: one WRITE_OFF movement per frozen slice, each posting
 * Dr 5300 Inventory Write-offs / Cr 1200 Inventory at the carrying value the
 * valuation rules derive — the ordinary outbound path, unchanged.
 *
 * It thaws first, in this same transaction, because an outbound movement is
 * checked against SELLABLE and frozen stock is by definition not sellable. Doing
 * both here means there is no instant at which the stock is thawed but not yet
 * written off.
 *
 * This is the ONLY path by which frozen stock becomes a general-ledger event.
 * src/services/offline/freeze.ts decides that an admin asked for it and records
 * the decision; the movements and the journal entries are this module's, as
 * always.
 */
export async function writeOffFrozenStockWithinTransaction(
  tx: LedgerTx,
  schema: string,
  locationId: string,
  reference: string,
  notes: string,
  userId: string,
): Promise<StockMovementResult[]> {
  assertValidSchemaName(schema);

  const frozen = await getFrozenStockAtLocationWithinTransaction(tx, schema, locationId);
  if (frozen.length === 0) {
    return [];
  }

  await thawLocationStockWithinTransaction(tx, schema, locationId);

  const movements: StockMovementResult[] = [];
  for (const slice of frozen) {
    movements.push(
      await recordStockMovementWithinTransaction(tx, schema, {
        productId: slice.productId,
        movementType: "WRITE_OFF",
        quantity: slice.frozenQuantity,
        createdBy: userId,
        entryDate: new Date(),
        reference,
        notes,
        locationId,
      }),
    );
  }
  return movements;
}

/** The transaction-scoped twin of getFrozenStockAtLocation, with a row lock. */
async function getFrozenStockAtLocationWithinTransaction(
  tx: LedgerTx,
  schema: string,
  locationId: string,
): Promise<FrozenSliceRow[]> {
  const rows = await tx.$queryRawUnsafe<FrozenSliceRawRow[]>(
    `SELECT ${FROZEN_SLICE_COLUMNS}
     FROM "${schema}".product_location_stock pls
     JOIN "${schema}".products p ON p."id" = pls."productId"
     WHERE pls."locationId" = $1 AND pls."frozenQuantity" > 0
     ORDER BY p."sku" ASC
     FOR UPDATE OF pls`,
    locationId,
  );
  return rows.map(mapFrozenSlice);
}

/** Everything a location owns right now, frozen or not — the sync's remainder read. */
export async function getOwnedStockAtLocationWithinTransaction(
  tx: LedgerTx,
  schema: string,
  locationId: string,
): Promise<FrozenSliceRow[]> {
  assertValidSchemaName(schema);
  const rows = await tx.$queryRawUnsafe<FrozenSliceRawRow[]>(
    `SELECT ${FROZEN_SLICE_COLUMNS}
     FROM "${schema}".product_location_stock pls
     JOIN "${schema}".products p ON p."id" = pls."productId"
     WHERE pls."locationId" = $1 AND pls."quantity" > 0
     ORDER BY p."sku" ASC
     FOR UPDATE OF pls`,
    locationId,
  );
  return rows.map(mapFrozenSlice);
}
// ===========================================================================
// PER-LOCATION VALUE IS A DERIVED, RESIDUAL-ALLOCATED PROJECTION (Task 3.1-FIX)
//
// Product.stockValue is the authoritative carrying amount and it lives at the
// PRODUCT level. There are no per-location cost layers in MVP — the same
// physical unit must not be worth different amounts in different locations, or
// the weighted average that account 1200 reconciles against forks.
//
// So a location's value is DERIVED: each location's owned quantity takes its
// proportional share of the product's stockValue. Rounding each share
// independently would not sum back — N locations can round up to N cents away
// from an aggregate that was only rounded once, and money that appears out of
// rounding is exactly what this task removed. Therefore every slice but the
// LARGEST is apportioned, and the largest receives the balance. The result sums
// EXACTLY to stockValue by construction rather than by luck.
//
// A location holding zero quantity derives exactly zero value, and residuals
// are allocated only among the positive-quantity slices — a location that owns
// nothing must never be handed a stray cent.
// ===========================================================================

interface LocationSlice {
  locationId: string;
  quantityMilli: bigint;
}

function allocateProductValue(
  stockValue: Cents,
  slices: ReadonlyArray<LocationSlice>,
): Map<string, Cents> {
  const allocation = new Map<string, Cents>();
  for (const slice of slices) {
    allocation.set(slice.locationId, 0n);
  }

  const positive = slices.filter((slice) => slice.quantityMilli > 0n);
  if (positive.length === 0) {
    // Nothing is owned anywhere. By the zero invariant stockValue is 0 too, so
    // there is nothing to apportion and every slice keeps its zero.
    return allocation;
  }

  let totalMilli = 0n;
  for (const slice of positive) {
    totalMilli += slice.quantityMilli;
  }

  // Deterministic ordering: largest holding first, ties broken by locationId so
  // two calls on the same data always allocate the residual to the same place.
  const ordered = [...positive].sort((a, b) => {
    if (a.quantityMilli === b.quantityMilli) {
      return a.locationId.localeCompare(b.locationId);
    }
    return b.quantityMilli > a.quantityMilli ? 1 : -1;
  });

  let allocated = 0n;
  for (let i = 1; i < ordered.length; i += 1) {
    const slice = ordered[i];
    if (slice === undefined) {
      continue;
    }
    const value = proportionalCost(slice.quantityMilli, totalMilli, stockValue);
    allocation.set(slice.locationId, value);
    allocated += value;
  }

  // The largest slice absorbs the residual, where a one-cent adjustment is
  // proportionally smallest.
  const largest = ordered[0];
  if (largest !== undefined) {
    allocation.set(largest.locationId, stockValue - allocated);
  }
  return allocation;
}

// ---- read models ----

export interface StockLevelFilters {
  category?: string;
  belowReorderOnly?: boolean;
}

export interface StockLevelRow {
  productId: string;
  sku: string;
  name: string;
  category: string | null;
  unitOfMeasure: string;
  stockCount: string;
  minStockThreshold: string;
  reorderQuantity: string | null;
  /** Derived from stockValue / stockCount, rounded to cents. */
  avgCost: Cents;
  /** The same derived rate to six decimal places of a cent. Not money — a rate. */
  avgCostPrecise: string;
  /** AUTHORITATIVE carrying value. */
  stockValue: Cents;
  belowReorder: boolean;
}

export async function getStockLevels(
  db: TenantPrismaClient,
  filters: StockLevelFilters,
): Promise<StockLevelRow[]> {
  const products = await db.product.findMany({
    where: {
      ...(filters.category !== undefined ? { category: filters.category } : {}),
    },
    orderBy: { sku: "asc" },
  });

  const rows = products.map((product) => {
    const stockMilli = decimalToMilli(product.stockCount);
    const thresholdMilli = decimalToMilli(product.minStockThreshold);
    // Derived from the two authoritative figures, not read back from the cache.
    const rateMicro = deriveAvgCost(product.stockValue, stockMilli);
    return {
      productId: product.id,
      sku: product.sku,
      name: product.name,
      category: product.category,
      unitOfMeasure: product.unitOfMeasure,
      stockCount: product.stockCount.toString(),
      minStockThreshold: product.minStockThreshold.toString(),
      reorderQuantity: product.reorderQuantity === null ? null : product.reorderQuantity.toString(),
      avgCost: displayAvgCost(rateMicro),
      avgCostPrecise: formatAvgCost(rateMicro),
      stockValue: product.stockValue,
      belowReorder: stockMilli <= thresholdMilli,
    };
  });

  return filters.belowReorderOnly === true ? rows.filter((row) => row.belowReorder) : rows;
}

export interface MovementHistoryRow {
  id: string;
  movementType: StockMovementType;
  quantity: string;
  unitCost: Cents;
  totalCost: Cents;
  balanceQty: string;
  balanceValue: Cents;
  avgCostAfter: Cents;
  supplierId: string | null;
  reference: string | null;
  notes: string | null;
  journalEntryId: string | null;
  locationId: string | null;
  goodsReceiptId: string | null;
  purchaseOrderLineId: string | null;
  createdBy: string;
  createdAt: Date;
}

export interface MovementHistoryResult {
  productId: string;
  rows: MovementHistoryRow[];
  pagination: { take: number; skip: number; total: number };
}

export async function getMovementHistory(
  db: TenantPrismaClient,
  productId: string,
  from: Date | undefined,
  to: Date | undefined,
  take: number,
  skip: number,
): Promise<MovementHistoryResult> {
  const clampedTake = Number.isInteger(take) ? Math.min(100, Math.max(1, take)) : 25;
  const clampedSkip = Number.isInteger(skip) && skip >= 0 ? skip : 0;

  const dateFilter: { gte?: Date; lte?: Date } = {};
  if (from !== undefined) {
    dateFilter.gte = from;
  }
  if (to !== undefined) {
    dateFilter.lte = to;
  }

  const where = {
    productId,
    ...(from !== undefined || to !== undefined ? { createdAt: dateFilter } : {}),
  };

  const [movements, total] = await Promise.all([
    db.stockMovement.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: clampedTake,
      skip: clampedSkip,
    }),
    db.stockMovement.count({ where }),
  ]);

  return {
    productId,
    rows: movements.map((movement) => ({
      id: movement.id,
      movementType: movement.movementType,
      quantity: movement.quantity.toString(),
      unitCost: movement.unitCost,
      totalCost: movement.totalCost,
      balanceQty: movement.balanceQty.toString(),
      balanceValue: movement.balanceValue,
      avgCostAfter: movement.avgCostAfter,
      supplierId: movement.supplierId,
      reference: movement.reference,
      notes: movement.notes,
      journalEntryId: movement.journalEntryId,
      locationId: movement.locationId,
      goodsReceiptId: movement.goodsReceiptId,
      purchaseOrderLineId: movement.purchaseOrderLineId,
      createdBy: movement.createdBy,
      createdAt: movement.createdAt,
    })),
    pagination: { take: clampedTake, skip: clampedSkip, total },
  };
}

// Location READS and location MANAGEMENT both live in src/services/locations.ts
// (Task 10.2), which is the sole writer of the locations table. This service
// still resolves a location internally when it stamps a movement — that is a
// read of a dimension, not the management surface.

// ---- per-location owned stock reads (Task 10.1, valuation per Task 3.1-FIX) ----

// One raw shape serves every per-location read: the owned slice plus the
// product's two AUTHORITATIVE figures, from which the rate and the slice's
// value are derived. avgCost is never read back out of its cache column here.
interface LocationSliceRawRow {
  product_id: string;
  sku: string;
  product_name: string;
  location_id: string;
  location_code: string;
  location_name: string;
  quantity: Prisma.Decimal;
  frozen_quantity: Prisma.Decimal;
  stock_count: Prisma.Decimal;
  stock_value: bigint;
}

const LOCATION_SLICE_COLUMNS = `pls."productId"  AS product_id,
            p."sku"          AS sku,
            p."name"         AS product_name,
            pls."locationId" AS location_id,
            l."code"         AS location_code,
            l."name"         AS location_name,
            pls."quantity"   AS quantity,
            pls."frozenQuantity" AS frozen_quantity,
            p."stockCount"   AS stock_count,
            p."stockValue"   AS stock_value`;

interface AllocatedSlice {
  row: LocationSliceRawRow;
  quantityMilli: bigint;
  value: Cents;
}

/**
 * Group raw slices by product and allocate each product's stockValue across
 * them. Allocation MUST see every one of a product's slices, so callers filter
 * the OUTPUT by location — never the input to this function.
 */
function allocateSlices(rows: ReadonlyArray<LocationSliceRawRow>): AllocatedSlice[] {
  const byProduct = new Map<string, LocationSliceRawRow[]>();
  for (const row of rows) {
    const bucket = byProduct.get(row.product_id);
    if (bucket === undefined) {
      byProduct.set(row.product_id, [row]);
    } else {
      bucket.push(row);
    }
  }

  const allocated: AllocatedSlice[] = [];
  for (const slices of byProduct.values()) {
    const quantities = slices.map((row) => ({
      locationId: row.location_id,
      quantityMilli: decimalToMilli(row.quantity),
    }));
    const first = slices[0];
    const stockValue = first === undefined ? 0n : first.stock_value;
    const allocation = allocateProductValue(stockValue, quantities);
    for (const row of slices) {
      allocated.push({
        row,
        quantityMilli: decimalToMilli(row.quantity),
        value: allocation.get(row.location_id) ?? 0n,
      });
    }
  }
  return allocated;
}

export interface StockByLocationRow {
  locationId: string;
  code: string;
  name: string;
  stockValue: Cents;
}

export interface StockByLocationResult {
  locations: StockByLocationRow[];
  totalStockValue: Cents;
  reconciliation: {
    byLocationTotal: Cents;
    productAggregate: Cents;
    glAccount1200Balance: Cents;
    difference: Cents; // must be 0
    reconciled: boolean;
  };
}

interface GlBalanceRawRow {
  d: bigint;
  c: bigint;
}

interface LocationMetaRow {
  id: string;
  code: string;
  name: string;
}

// Inventory value grouped by location, derived from what each location OWNS
// right now (product_location_stock) rather than replayed from movement
// history: ownership is the current-balance truth, and its per-product residual
// allocation is what makes the location values sum EXACTLY to the tenant
// aggregate. Every location is listed, including ones holding nothing.
export async function getStockByLocation(
  db: TenantPrismaClient,
): Promise<StockByLocationResult> {
  const schema = resolveSchema(db);

  const rows = await db.$queryRawUnsafe<LocationSliceRawRow[]>(
    `SELECT ${LOCATION_SLICE_COLUMNS}
     FROM "${schema}".product_location_stock pls
     JOIN "${schema}".products  p ON p.id = pls."productId"
     JOIN "${schema}".locations l ON l.id = pls."locationId"`,
  );

  const valueByLocation = new Map<string, Cents>();
  for (const slice of allocateSlices(rows)) {
    valueByLocation.set(
      slice.row.location_id,
      (valueByLocation.get(slice.row.location_id) ?? 0n) + slice.value,
    );
  }

  const locationRows = await db.$queryRawUnsafe<LocationMetaRow[]>(
    `SELECT id, code, name FROM "${schema}".locations ORDER BY code ASC`,
  );

  let byLocationTotal = 0n;
  const locations: StockByLocationRow[] = locationRows.map((location) => {
    const value = valueByLocation.get(location.id) ?? 0n;
    byLocationTotal += value;
    return { locationId: location.id, code: location.code, name: location.name, stockValue: value };
  });

  const productAgg = await db.product.aggregate({ _sum: { stockValue: true } });
  const productAggregate = productAgg._sum.stockValue ?? 0n;

  const glRows = await db.$queryRawUnsafe<GlBalanceRawRow[]>(
    `SELECT COALESCE(SUM(jl.debit), 0)::bigint  AS d,
            COALESCE(SUM(jl.credit), 0)::bigint AS c
     FROM "${schema}".journal_lines jl
     JOIN "${schema}".accounts a ON a.id = jl."accountId"
     WHERE a.code = '1200'`,
  );
  const glFirst = glRows[0];
  const glAccount1200Balance = glFirst === undefined ? 0n : glFirst.d - glFirst.c;

  const difference = byLocationTotal - glAccount1200Balance;

  return {
    locations,
    totalStockValue: byLocationTotal,
    reconciliation: {
      byLocationTotal,
      productAggregate,
      glAccount1200Balance,
      difference,
      reconciled: difference === 0n && byLocationTotal === productAggregate,
    },
  };
}

export interface LocationStockRow {
  productId: string;
  sku: string;
  name: string;
  locationId: string;
  locationCode: string;
  locationName: string;
  /** Total OWNED at this location, frozen included — the figure that sums to Product.stockCount. */
  quantity: string;
  /** The immobilised portion (an expired lease awaiting reconciliation). Usually zero. */
  frozenQuantity: string;
  /** quantity - frozenQuantity: what this location may actually sell or send. */
  sellableQuantity: string;
  /** The product's derived tenant-wide rate, rounded to cents — not a per-location cost. */
  avgCost: Cents;
  /** The same rate to six decimal places of a cent. */
  avgCostPrecise: string;
  /**
   * This slice's residual-allocated share of the product's stockValue, derived
   * from the TOTAL owned quantity. Frozen stock is still carried value — it is
   * still the tenant's stock and still in GL 1200 — which is exactly why a freeze
   * posts no journal entry.
   */
  value: Cents;
}

export interface LocationStockFilters {
  locationId?: string;
  productId?: string;
}

export async function getLocationStock(
  db: TenantPrismaClient,
  filters: LocationStockFilters,
): Promise<LocationStockRow[]> {
  const schema = resolveSchema(db);

  // Parameterised filters; only the schema name is interpolated, and it comes
  // from tenantSchemaFor + assertValidSchemaName.
  //
  // The locationId filter selects PRODUCTS present at that location and still
  // loads ALL of their slices, because a residual allocation that could not see
  // every slice would not sum to the product's stockValue. The location filter
  // is then applied to the output below.
  const rows = await db.$queryRawUnsafe<LocationSliceRawRow[]>(
    `SELECT ${LOCATION_SLICE_COLUMNS}
     FROM "${schema}".product_location_stock pls
     JOIN "${schema}".products  p ON p.id = pls."productId"
     JOIN "${schema}".locations l ON l.id = pls."locationId"
     WHERE ($2::text IS NULL OR pls."productId" = $2)
       AND ($1::text IS NULL OR pls."productId" IN (
             SELECT inner_pls."productId"
             FROM "${schema}".product_location_stock inner_pls
             WHERE inner_pls."locationId" = $1))
     ORDER BY l."code" ASC, p."sku" ASC`,
    filters.locationId ?? null,
    filters.productId ?? null,
  );

  const allocated = allocateSlices(rows).filter(
    (slice) => filters.locationId === undefined || slice.row.location_id === filters.locationId,
  );

  allocated.sort((a, b) => {
    const byCode = a.row.location_code.localeCompare(b.row.location_code);
    return byCode !== 0 ? byCode : a.row.sku.localeCompare(b.row.sku);
  });

  return allocated.map((slice) => {
    const rateMicro = deriveAvgCost(slice.row.stock_value, decimalToMilli(slice.row.stock_count));
    const frozenMilli = decimalToMilli(slice.row.frozen_quantity);
    return {
      productId: slice.row.product_id,
      sku: slice.row.sku,
      name: slice.row.product_name,
      locationId: slice.row.location_id,
      locationCode: slice.row.location_code,
      locationName: slice.row.location_name,
      // Normalised to Decimal(14,3) form: a raw Decimal renders zero as "0",
      // which would make one slice in a list read differently from the rest.
      quantity: milliToDecimalString(slice.quantityMilli),
      frozenQuantity: milliToDecimalString(frozenMilli),
      sellableQuantity: milliToDecimalString(slice.quantityMilli - frozenMilli),
      avgCost: displayAvgCost(rateMicro),
      avgCostPrecise: formatAvgCost(rateMicro),
      value: slice.value,
    };
  });
}

export interface ProductLocationSplitEntry {
  locationId: string;
  locationCode: string;
  locationName: string;
  quantity: string;
  value: Cents;
}

export interface ProductLocationSplitResult {
  productId: string;
  sku: string;
  name: string;
  /** The tenant-wide aggregate held on Product.stockCount. */
  aggregateStockCount: string;
  /** The sum of the per-location owned quantities below. */
  locationTotal: string;
  /** The invariant: these two must be equal. */
  matches: boolean;
  /** AUTHORITATIVE carrying value; the per-location values below sum to it exactly. */
  stockValue: Cents;
  /** Sum of the per-location values; must equal stockValue to the cent. */
  locationValueTotal: Cents;
  valueMatches: boolean;
  avgCost: Cents;
  avgCostPrecise: string;
  locations: ProductLocationSplitEntry[];
}

export async function getProductLocationSplit(
  db: TenantPrismaClient,
  productId: string,
): Promise<ProductLocationSplitResult | null> {
  const product = await db.product.findUnique({ where: { id: productId } });
  if (product === null) {
    return null;
  }

  const rows = await getLocationStock(db, { productId });

  let totalMilli = 0n;
  let locationValueTotal = 0n;
  const locations: ProductLocationSplitEntry[] = rows.map((row) => {
    totalMilli += decimalToMilli(row.quantity);
    locationValueTotal += row.value;
    return {
      locationId: row.locationId,
      locationCode: row.locationCode,
      locationName: row.locationName,
      quantity: row.quantity,
      value: row.value,
    };
  });

  const aggregateMilli = decimalToMilli(product.stockCount);
  const rateMicro = deriveAvgCost(product.stockValue, aggregateMilli);

  return {
    productId: product.id,
    sku: product.sku,
    name: product.name,
    aggregateStockCount: milliToDecimalString(aggregateMilli),
    locationTotal: milliToDecimalString(totalMilli),
    matches: aggregateMilli === totalMilli,
    stockValue: product.stockValue,
    locationValueTotal,
    valueMatches: locationValueTotal === product.stockValue,
    avgCost: displayAvgCost(rateMicro),
    avgCostPrecise: formatAvgCost(rateMicro),
    locations,
  };
}

export interface InventoryValuationProduct {
  productId: string;
  sku: string;
  name: string;
  stockCount: string;
  avgCost: Cents;
  avgCostPrecise: string;
  stockValue: Cents;
}

export interface InventoryValuationLocation {
  locationId: string;
  locationCode: string;
  locationName: string;
  /** Total owned quantity across all products at this location. */
  quantity: string;
  /** Derived, residual-allocated value of that stock. */
  value: Cents;
}

export interface InventoryValuationResult {
  asOf: string;
  totalStockValue: Cents;
  products: InventoryValuationProduct[];
  /**
   * WHERE the stock physically sits. The GL reconciliation stays TENANT-WIDE
   * (account 1200 is not per-location); this breakdown is operational
   * information layered on top of it.
   */
  byLocation: InventoryValuationLocation[];
  reconciliation: {
    inventoryValue: Cents;
    glAccount1200Balance: Cents;
    difference: Cents; // must be 0
    reconciled: boolean;
    /** Sum of the per-location values above; must equal inventoryValue exactly. */
    byLocationTotal: Cents;
    locationSplitMatches: boolean;
    /** stockCount = 0 must imply stockValue = 0 for every product (CHECK-backed). */
    zeroInvariantHolds: boolean;
  };
}

export async function getInventoryValuation(
  db: TenantPrismaClient,
  asOf: Date,
): Promise<InventoryValuationResult> {
  const schema = resolveSchema(db);

  const products = await db.product.findMany({ orderBy: { sku: "asc" } });
  let inventoryValue = 0n;
  let zeroInvariantHolds = true;
  const productRows: InventoryValuationProduct[] = products.map((product) => {
    inventoryValue += product.stockValue;
    const qtyMilli = decimalToMilli(product.stockCount);
    if (qtyMilli === 0n && product.stockValue !== 0n) {
      zeroInvariantHolds = false;
    }
    const rateMicro = deriveAvgCost(product.stockValue, qtyMilli);
    return {
      productId: product.id,
      sku: product.sku,
      name: product.name,
      stockCount: product.stockCount.toString(),
      avgCost: displayAvgCost(rateMicro),
      avgCostPrecise: formatAvgCost(rateMicro),
      stockValue: product.stockValue,
    };
  });

  // GL balance of account 1200 Inventory (ASSET, normal DEBIT) as of the date.
  const rows = await db.$queryRawUnsafe<GlBalanceRawRow[]>(
    `SELECT COALESCE(SUM(jl.debit), 0)::bigint  AS d,
            COALESCE(SUM(jl.credit), 0)::bigint AS c
     FROM "${schema}".journal_lines jl
     JOIN "${schema}".accounts a         ON a.id  = jl."accountId"
     JOIN "${schema}".journal_entries je ON je.id = jl."entryId"
     WHERE a.code = '1200' AND je."entryDate" <= $1`,
    asOf,
  );
  const first = rows[0];
  const glBalance = first === undefined ? 0n : first.d - first.c;
  const difference = inventoryValue - glBalance;

  const byLocation = await buildLocationValuation(db);
  let byLocationTotal = 0n;
  for (const location of byLocation) {
    byLocationTotal += location.value;
  }

  return {
    asOf: asOf.toISOString().slice(0, 10),
    totalStockValue: inventoryValue,
    products: productRows,
    byLocation,
    reconciliation: {
      inventoryValue,
      glAccount1200Balance: glBalance,
      difference,
      reconciled: difference === 0n,
      byLocationTotal,
      locationSplitMatches: byLocationTotal === inventoryValue,
      zeroInvariantHolds,
    },
  };
}

/**
 * Value each location's holding by the same derived, residual-allocated rule as
 * every other per-location read — one definition of "value at a location" in
 * the whole service, so two endpoints can never report two figures.
 */
async function buildLocationValuation(
  db: TenantPrismaClient,
): Promise<InventoryValuationLocation[]> {
  const schema = resolveSchema(db);

  const rows = await db.$queryRawUnsafe<LocationSliceRawRow[]>(
    `SELECT ${LOCATION_SLICE_COLUMNS}
     FROM "${schema}".product_location_stock pls
     JOIN "${schema}".products  p ON p.id = pls."productId"
     JOIN "${schema}".locations l ON l.id = pls."locationId"`,
  );

  const quantityByLocation = new Map<string, bigint>();
  const valueByLocation = new Map<string, Cents>();
  const metaByLocation = new Map<string, { code: string; name: string }>();

  for (const slice of allocateSlices(rows)) {
    const locationId = slice.row.location_id;
    quantityByLocation.set(locationId, (quantityByLocation.get(locationId) ?? 0n) + slice.quantityMilli);
    valueByLocation.set(locationId, (valueByLocation.get(locationId) ?? 0n) + slice.value);
    metaByLocation.set(locationId, { code: slice.row.location_code, name: slice.row.location_name });
  }

  const result: InventoryValuationLocation[] = [];
  for (const [locationId, meta] of metaByLocation) {
    result.push({
      locationId,
      locationCode: meta.code,
      locationName: meta.name,
      quantity: milliToDecimalString(quantityByLocation.get(locationId) ?? 0n),
      value: valueByLocation.get(locationId) ?? 0n,
    });
  }
  result.sort((a, b) => a.locationCode.localeCompare(b.locationCode));
  return result;
}

// ===========================================================================
// ONE-TIME CORRECTIVE PROJECTION REBUILD (Task 3.1-FIX)
//
// The pre-fix model computed stockValue as quantity * a ROUNDED avgCost while
// the ledger accumulated the EXACT cost of every movement, so the two drifted
// apart whenever a weighted average did not divide evenly. The drift lives in
// the projection (Product.stockValue), never in the history: stock_movements
// and journal_entries are immutable and both already carry the real posted
// figures — a movement's totalCost IS the amount its journal entry posted.
//
// So the correction is a REBUILD OF THE PROJECTION FROM AUTHORITATIVE HISTORY,
// not a recompute from avgCost and not an edit of anything immutable:
//
//     stockValue := SUM(inbound totalCost) - SUM(outbound totalCost)
//
// Value-neutral transfers contribute a matched TRANSFER_OUT/TRANSFER_IN pair
// and therefore net to exactly zero, as they must.
//
// This function REFUSES rather than guesses. It never rewrites stockCount (a
// physical quantity is not ours to invent), and it never silently zeroes a
// ghost balance — zero stock carrying a non-zero posted value is a real
// accounting event that needs a written-off decision, not a quiet UPDATE.
//
// It lives here because src/services/inventory.ts is the ONLY module permitted
// to move Product.stockValue. The CLI script merely drives it per tenant.
// ===========================================================================

/** The rebuild found something it must not decide on its own. */
export class StockRebuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StockRebuildError";
  }
}

export interface StockValueRebuildRow {
  productId: string;
  sku: string;
  stockCount: string;
  /** The exact net cost this product's immutable movement history posted. */
  postedValue: Cents;
  previousStockValue: Cents;
  /** postedValue - previousStockValue; zero on an already-correct product. */
  correction: Cents;
  previousAvgCost: Cents;
  avgCost: Cents;
  avgCostPrecise: string;
}

export interface StockValueReconciliation {
  inventoryValue: Cents;
  glAccount1200Balance: Cents;
  difference: Cents;
}

export interface StockValueRebuildResult {
  rows: StockValueRebuildRow[];
  changed: number;
  totalCorrection: Cents;
  before: StockValueReconciliation;
  after: StockValueReconciliation;
}

interface RebuildRawRow {
  id: string;
  sku: string;
  stock_count: string;
  stock_value: bigint;
  avg_cost: bigint;
  posted_value: bigint;
  posted_qty: string;
}

async function readInventoryReconciliation(
  tx: LedgerTx,
  schema: string,
): Promise<StockValueReconciliation> {
  const valueRows = await tx.$queryRawUnsafe<Array<{ v: bigint }>>(
    `SELECT COALESCE(SUM("stockValue"), 0)::bigint AS v FROM "${schema}".products`,
  );
  const glRows = await tx.$queryRawUnsafe<GlBalanceRawRow[]>(
    `SELECT COALESCE(SUM(jl.debit), 0)::bigint  AS d,
            COALESCE(SUM(jl.credit), 0)::bigint AS c
     FROM "${schema}".journal_lines jl
     JOIN "${schema}".accounts a ON a.id = jl."accountId"
     WHERE a.code = '1200'`,
  );
  const inventoryValue = valueRows[0]?.v ?? 0n;
  const glFirst = glRows[0];
  const glAccount1200Balance = glFirst === undefined ? 0n : glFirst.d - glFirst.c;
  return {
    inventoryValue,
    glAccount1200Balance,
    difference: inventoryValue - glAccount1200Balance,
  };
}

export interface StockValueRebuildOptions {
  /** false computes and reports the correction without writing anything. */
  apply?: boolean;
}

/**
 * Rebuild every product's stockValue (and the avgCost cache derived from it)
 * from the immutable stock_movements history. Idempotent: a second run reports
 * zero corrections. Runs in ONE transaction so the tenant is never half-rebuilt.
 */
export async function rebuildStockValueFromHistory(
  db: TenantPrismaClient,
  options: StockValueRebuildOptions = {},
): Promise<StockValueRebuildResult> {
  const schema = resolveSchema(db);
  const apply = options.apply !== false;

  return db.$transaction(async (tx) => {
    const before = await readInventoryReconciliation(tx, schema);

    const raw = await tx.$queryRawUnsafe<RebuildRawRow[]>(
      `SELECT p.id                AS id,
              p."sku"             AS sku,
              p."stockCount"::text AS stock_count,
              p."stockValue"      AS stock_value,
              p."avgCost"         AS avg_cost,
              COALESCE(SUM(CASE WHEN sm.quantity > 0 THEN sm."totalCost" ELSE -sm."totalCost" END), 0)::bigint AS posted_value,
              COALESCE(SUM(sm.quantity), 0)::text AS posted_qty
       FROM "${schema}".products p
       LEFT JOIN "${schema}".stock_movements sm ON sm."productId" = p.id
       GROUP BY p.id, p."sku", p."stockCount", p."stockValue", p."avgCost"
       ORDER BY p."sku" ASC`,
    );

    const rows: StockValueRebuildRow[] = [];
    let changed = 0;
    let totalCorrection = 0n;

    for (const row of raw) {
      const qtyMilli = decimalToMilli(row.stock_count);
      const postedQtyMilli = decimalToMilli(row.posted_qty);

      // stockCount is authoritative and is NEVER rewritten here. If it does not
      // agree with the history, something outside the inventory service moved
      // stock and that must be investigated, not papered over.
      if (qtyMilli !== postedQtyMilli) {
        throw new StockRebuildError(
          `${row.sku}: stockCount ${milliToDecimalString(qtyMilli)} does not match the movement history ${milliToDecimalString(postedQtyMilli)}. Refusing to rebuild — investigate before correcting.`,
        );
      }
      if (row.posted_value < 0n) {
        throw new StockRebuildError(
          `${row.sku}: the movement history nets to a negative value (${row.posted_value.toString()} cents). Refusing to rebuild.`,
        );
      }
      if (qtyMilli === 0n && row.posted_value !== 0n) {
        throw new StockRebuildError(
          `${row.sku}: zero stock carries a posted value of ${row.posted_value.toString()} cents — a ghost balance. Clear it with a write-off (5300) through the inventory service; the rebuild will not silently discard it.`,
        );
      }

      const rateMicro = deriveAvgCost(row.posted_value, qtyMilli);
      const avgCost = displayAvgCost(rateMicro);
      const correction = row.posted_value - row.stock_value;

      if (apply && (correction !== 0n || avgCost !== row.avg_cost)) {
        await tx.product.update({
          where: { id: row.id },
          data: { stockValue: row.posted_value, avgCost },
        });
      }
      if (correction !== 0n) {
        changed += 1;
        totalCorrection += correction;
      }

      rows.push({
        productId: row.id,
        sku: row.sku,
        stockCount: milliToDecimalString(qtyMilli),
        postedValue: row.posted_value,
        previousStockValue: row.stock_value,
        correction,
        previousAvgCost: row.avg_cost,
        avgCost,
        avgCostPrecise: formatAvgCost(rateMicro),
      });
    }

    // Computed, not read back, so a non-applying run reports the same figures
    // an applying one would produce. sum(postedValue) is what stockValue WILL
    // be; the GL balance is untouched by the rebuild either way.
    let rebuiltValue = 0n;
    for (const row of rows) {
      rebuiltValue += row.postedValue;
    }
    const after: StockValueReconciliation = {
      inventoryValue: rebuiltValue,
      glAccount1200Balance: before.glAccount1200Balance,
      difference: rebuiltValue - before.glAccount1200Balance,
    };

    return { rows, changed, totalCorrection, before, after };
  });
}
