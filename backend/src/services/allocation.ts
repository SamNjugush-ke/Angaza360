// ===========================================================================
// ALLOCATION WORKFLOW (Module 10, Task 10.2).
//
// THIS IS THE ONLY MODULE PERMITTED TO WRITE `allocation_requests`. It writes NO
// STOCK TABLE AT ALL — not stock_movements, not product_location_stock, not
// Product.stockCount / stockValue / avgCost, and it never posts to the ledger.
// Every stock effect below is performed by src/services/inventory.ts, which
// remains the sole stock writer; this module only decides WHETHER and WHEN one
// happens, and records who asked and who approved.
//
// WHAT AN ALLOCATION ACTUALLY IS: a transfer into a selling location. Nothing
// more. It moves owned quantity from the MAIN pool to a till or a storefront
// using the same value-neutral TRANSFER_OUT/TRANSFER_IN pair Task 10.1 built —
// so an allocation posts NO journal entry, leaves Product.stockCount,
// stockValue and avgCost untouched, and keeps sum(stockValue) = GL(1200) true
// by construction. There is no new stock mechanism here, only a workflow around
// the existing one.
//
// A REQUEST MOVES NOTHING. createAllocationRequest writes one PENDING row and
// stops. No stock moves, no movement is recorded, nothing is reserved. Stock
// moves only when an admin APPROVES, and then the status flip and the transfer
// happen in ONE transaction — so a request can never be marked approved without
// its stock having moved, nor stock move without the approval being recorded.
//
// LEASE ENFORCEMENT IS NOT HERE. A destination location may carry a lease
// window (see src/services/locations.ts), but nothing in this file reads it,
// starts a lease clock, expires one, or freezes an allocation. That is the
// offline server foundation, the next task. See the seam note in locations.ts.
// ===========================================================================

import type { Prisma, PrismaClient as TenantPrismaClient } from "../generated/tenant/client";
import type { AllocationRequestStatus, LocationType } from "../generated/tenant/enums";
import { assertValidSchemaName, tenantSchemaFor } from "../db/tenant";
import { decimalToMilli, milliToDecimalString } from "../lib/inventory-math";
import {
  transferStock,
  transferStockWithinTransaction,
  withInventoryErrorTranslation,
  type TransferStockResult,
} from "./inventory";
import { LocationValidationError } from "./locations";

// ---- error types the route layer maps to HTTP codes ----

/** Bad input (unknown product/location, non-positive quantity). Route -> 400. */
export class AllocationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllocationValidationError";
  }
}

/** The request's current state forbids the operation (already decided). Route -> 409. */
export class AllocationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllocationStateError";
  }
}

/** The caller may not act on this request (cancelling someone else's). Route -> 403. */
export class AllocationForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllocationForbiddenError";
  }
}

function resolveSchema(db: TenantPrismaClient): string {
  const schema = tenantSchemaFor(db);
  assertValidSchemaName(schema);
  return schema;
}

function parsePositiveQuantity(raw: string, field: string): bigint {
  let milli: bigint;
  try {
    milli = decimalToMilli(raw);
  } catch (error) {
    throw new AllocationValidationError(
      error instanceof Error ? error.message : `${field} is not a valid quantity.`,
    );
  }
  if (milli <= 0n) {
    throw new AllocationValidationError(`${field} must be a positive quantity.`);
  }
  return milli;
}

// ---------------------------------------------------------------------------
// Shared row shape
// ---------------------------------------------------------------------------

export interface AllocationRequestRow {
  id: string;
  productId: string;
  sku: string;
  productName: string;
  locationId: string;
  locationCode: string;
  locationName: string;
  requestedQty: string;
  approvedQty: string | null;
  status: AllocationRequestStatus;
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: Date | null;
  /** The TRANSFER_IN movement that delivered the approved stock. Set only on APPROVED. */
  transferId: string | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const REQUEST_INCLUDE = {
  product: { select: { sku: true, name: true } },
  location: { select: { code: true, name: true } },
} as const;

type RequestWithRelations = Prisma.AllocationRequestGetPayload<{
  include: typeof REQUEST_INCLUDE;
}>;

function toRow(request: RequestWithRelations): AllocationRequestRow {
  return {
    id: request.id,
    productId: request.productId,
    sku: request.product.sku,
    productName: request.product.name,
    locationId: request.locationId,
    locationCode: request.location.code,
    locationName: request.location.name,
    // Normalised through the milli parser so every quantity in the API renders
    // in the same Decimal(14,3) form — a raw Decimal prints "10" where the rest
    // of the system prints "10.000".
    requestedQty: milliToDecimalString(decimalToMilli(request.requestedQty)),
    approvedQty:
      request.approvedQty === null
        ? null
        : milliToDecimalString(decimalToMilli(request.approvedQty)),
    status: request.status,
    requestedBy: request.requestedBy,
    decidedBy: request.decidedBy,
    decidedAt: request.decidedAt,
    transferId: request.transferId,
    note: request.note,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// 1. DIRECT ALLOCATION — an admin pushing stock to a location, no prior request
// ---------------------------------------------------------------------------

export interface AllocateStockInput {
  productId: string;
  /** Defaults to the tenant's MAIN pool — the authoritative source of allocations. */
  fromLocationId?: string;
  toLocationId: string;
  quantity: string;
  createdBy: string;
  note?: string;
}

export interface AllocationResult {
  transfer: TransferStockResult;
  /** true when the source was resolved to MAIN because the caller named none. */
  sourceDefaulted: boolean;
}

/**
 * Allocate stock straight into a location. This is a THIN WRAPPER over the
 * inventory service's transfer: it resolves the default source (MAIN) and
 * labels the movement as an allocation, then delegates. It deliberately adds no
 * valuation, no ledger effect and no second stock path — everything that makes
 * a transfer safe (source-ownership check, immutable movement pair, untouched
 * aggregate and carrying value) is inherited rather than reimplemented.
 */
export async function allocateStock(
  db: TenantPrismaClient,
  input: AllocateStockInput,
): Promise<AllocationResult> {
  parsePositiveQuantity(input.quantity, "quantity");

  let fromLocationId: string;
  let sourceDefaulted: boolean;
  if (input.fromLocationId !== undefined) {
    fromLocationId = input.fromLocationId;
    sourceDefaulted = false;
  } else {
    const main = await db.location.findFirst({ where: { isDefault: true } });
    if (main === null) {
      throw new LocationValidationError(
        "No default (MAIN) location is configured for this tenant, so an allocation has no source.",
      );
    }
    fromLocationId = main.id;
    sourceDefaulted = true;
  }

  const transfer = await transferStock(db, {
    productId: input.productId,
    fromLocationId,
    toLocationId: input.toLocationId,
    quantity: input.quantity,
    reference: "ALLOCATION",
    ...(input.note !== undefined ? { notes: input.note } : {}),
    createdBy: input.createdBy,
  });

  return { transfer, sourceDefaulted };
}

// ---------------------------------------------------------------------------
// 2. REQUEST — an attendant asking for more stock. MOVES NOTHING.
// ---------------------------------------------------------------------------

export interface CreateAllocationRequestInput {
  productId: string;
  locationId: string;
  requestedQty: string;
  requestedBy: string;
  note?: string;
}

export async function createAllocationRequest(
  db: TenantPrismaClient,
  input: CreateAllocationRequestInput,
): Promise<AllocationRequestRow> {
  parsePositiveQuantity(input.requestedQty, "requestedQty");

  const product = await db.product.findUnique({ where: { id: input.productId } });
  if (product === null) {
    throw new AllocationValidationError(`Unknown product ${input.productId}.`);
  }
  const location = await db.location.findUnique({ where: { id: input.locationId } });
  if (location === null || !location.isActive) {
    throw new AllocationValidationError(`Unknown or inactive location ${input.locationId}.`);
  }
  if (location.isDefault) {
    throw new AllocationValidationError(
      `Location ${location.code} is the MAIN pool: allocation requests are for stock to be moved INTO a selling location, not into the pool it comes from. Record incoming stock as a purchase receipt instead.`,
    );
  }

  // No stock is touched, nothing is reserved, no movement is written. The row
  // below is a proposal and the queue it lands in is the whole of its effect.
  const created = await db.allocationRequest.create({
    data: {
      productId: product.id,
      locationId: location.id,
      requestedQty: input.requestedQty,
      status: "PENDING",
      requestedBy: input.requestedBy,
      note: input.note ?? null,
    },
    include: REQUEST_INCLUDE,
  });
  return toRow(created);
}

// ---------------------------------------------------------------------------
// 3. DECIDE — approve (moves stock) or decline (moves nothing). ONE transaction.
// ---------------------------------------------------------------------------

export type AllocationDecision = "APPROVED" | "DECLINED";

export interface DecideAllocationRequestInput {
  decision: AllocationDecision;
  /** Approvals only. Omitted -> the full requested quantity. */
  approvedQty?: string;
  decidedBy: string;
}

interface LockedRequestRow {
  id: string;
  status: AllocationRequestStatus;
  product_id: string;
  location_id: string;
  requested_qty: string;
}

/**
 * Approve or decline a pending request.
 *
 * On APPROVE the status flip and the MAIN -> location transfer happen inside ONE
 * transaction, through the inventory service's transaction-participating entry
 * point. Either both land or neither does: there is no window in which a request
 * reads APPROVED but its stock never moved, and none in which stock moved
 * against a request still sitting in the queue.
 *
 * If the source pool cannot cover the approved quantity, the transfer throws
 * InsufficientStockError, the transaction rolls back, NOTHING moves, and the
 * request STAYS PENDING — so the admin can approve a smaller quantity or
 * replenish MAIN and approve again. A failed approval is not a decision.
 */
export async function decideAllocationRequest(
  db: TenantPrismaClient,
  requestId: string,
  input: DecideAllocationRequestInput,
): Promise<AllocationRequestRow> {
  const schema = resolveSchema(db);

  return withInventoryErrorTranslation(() =>
    db.$transaction(async (tx) => {
      // Lock the request row before reading its status, so two concurrent
      // approvals serialise instead of both seeing PENDING and both
      // transferring. Migration 0013's terminal-state trigger is the backstop
      // behind this lock; this is the part that produces a clean error.
      const locked = await tx.$queryRawUnsafe<LockedRequestRow[]>(
        `SELECT "id", "status", "productId" AS product_id, "locationId" AS location_id,
                "requestedQty"::text AS requested_qty
         FROM "${schema}".allocation_requests
         WHERE "id" = $1
         FOR UPDATE`,
        requestId,
      );
      const request = locked[0];
      if (request === undefined) {
        throw new AllocationValidationError(`Unknown allocation request ${requestId}.`);
      }
      if (request.status !== "PENDING") {
        throw new AllocationStateError(
          `Allocation request ${requestId} is already ${request.status}; a decided request is final and cannot be re-decided.`,
        );
      }

      const decidedAt = new Date();

      if (input.decision === "DECLINED") {
        // Records the decision and nothing else. No transfer, no movement, no
        // approvedQty — the state CHECK in migration 0013 enforces that a
        // DECLINED row carries no quantity and no transfer link.
        const declined = await tx.allocationRequest.update({
          where: { id: requestId },
          data: { status: "DECLINED", decidedBy: input.decidedBy, decidedAt },
          include: REQUEST_INCLUDE,
        });
        return toRow(declined);
      }

      const approvedQty = input.approvedQty ?? request.requested_qty;
      parsePositiveQuantity(approvedQty, "approvedQty");

      // MAIN is the source of every allocation. Read inside the transaction so
      // the decision cannot be made against a location list that changed.
      const main = await tx.location.findFirst({ where: { isDefault: true } });
      if (main === null) {
        throw new LocationValidationError(
          "No default (MAIN) location is configured for this tenant, so an allocation has no source.",
        );
      }
      if (main.id === request.location_id) {
        throw new AllocationValidationError(
          "The requesting location is the MAIN pool; there is nowhere to transfer from.",
        );
      }

      // The stock effect. Performed by the inventory service — this module never
      // writes a stock table — and value-neutral: no journal entry, aggregate
      // and carrying value untouched.
      const transfer = await transferStockWithinTransaction(tx, schema, {
        productId: request.product_id,
        fromLocationId: main.id,
        toLocationId: request.location_id,
        quantity: approvedQty,
        reference: "ALLOCATION_REQUEST",
        notes: `Allocation request ${requestId} approved`,
        createdBy: input.decidedBy,
      });

      const approved = await tx.allocationRequest.update({
        where: { id: requestId },
        data: {
          status: "APPROVED",
          approvedQty,
          decidedBy: input.decidedBy,
          decidedAt,
          // The TRANSFER_IN — the movement that put the stock INTO the
          // requesting location. Pointing at the inbound leg is what makes
          // "this request delivered this stock here" answerable straight from
          // the immutable movement history.
          transferId: transfer.inMovementId,
        },
        include: REQUEST_INCLUDE,
      });
      return toRow(approved);
    }),
  );
}

// ---------------------------------------------------------------------------
// 4. CANCEL — the requester withdraws their own pending request. MOVES NOTHING.
// ---------------------------------------------------------------------------

export async function cancelAllocationRequest(
  db: TenantPrismaClient,
  requestId: string,
  userId: string,
): Promise<AllocationRequestRow> {
  const schema = resolveSchema(db);

  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRawUnsafe<Array<{ id: string; status: AllocationRequestStatus; requested_by: string }>>(
      `SELECT "id", "status", "requestedBy" AS requested_by
       FROM "${schema}".allocation_requests
       WHERE "id" = $1
       FOR UPDATE`,
      requestId,
    );
    const request = locked[0];
    if (request === undefined) {
      throw new AllocationValidationError(`Unknown allocation request ${requestId}.`);
    }
    if (request.requested_by !== userId) {
      throw new AllocationForbiddenError(
        "Only the user who created an allocation request may cancel it. An admin declines it instead.",
      );
    }
    if (request.status !== "PENDING") {
      throw new AllocationStateError(
        `Allocation request ${requestId} is already ${request.status}; only a pending request can be cancelled.`,
      );
    }

    // decidedBy records WHO took the request out of PENDING, which for a
    // cancellation is the requester themselves (migration 0013's state CHECK
    // requires a decider on every terminal row, so the queue always says who
    // ended it).
    const cancelled = await tx.allocationRequest.update({
      where: { id: requestId },
      data: { status: "CANCELLED", decidedBy: userId, decidedAt: new Date() },
      include: REQUEST_INCLUDE,
    });
    return toRow(cancelled);
  });
}

// ---------------------------------------------------------------------------
// 5. Reads
// ---------------------------------------------------------------------------

export interface AllocationRequestFilters {
  status?: AllocationRequestStatus;
  locationId?: string;
  productId?: string;
}

export async function listAllocationRequests(
  db: TenantPrismaClient,
  filters: AllocationRequestFilters = {},
): Promise<AllocationRequestRow[]> {
  const requests = await db.allocationRequest.findMany({
    where: {
      ...(filters.status !== undefined ? { status: filters.status } : {}),
      ...(filters.locationId !== undefined ? { locationId: filters.locationId } : {}),
      ...(filters.productId !== undefined ? { productId: filters.productId } : {}),
    },
    include: REQUEST_INCLUDE,
    orderBy: { createdAt: "desc" },
  });
  return requests.map(toRow);
}

export async function getAllocationRequest(
  db: TenantPrismaClient,
  id: string,
): Promise<AllocationRequestRow | null> {
  const request = await db.allocationRequest.findUnique({
    where: { id },
    include: REQUEST_INCLUDE,
  });
  return request === null ? null : toRow(request);
}

/** The admin's queue: everything waiting on a decision, oldest-first. */
export async function getPendingAllocationRequests(
  db: TenantPrismaClient,
): Promise<AllocationRequestRow[]> {
  const requests = await db.allocationRequest.findMany({
    where: { status: "PENDING" },
    include: REQUEST_INCLUDE,
    orderBy: { createdAt: "asc" },
  });
  return requests.map(toRow);
}

// ---------------------------------------------------------------------------
// 6. LOW-STOCK ALERT DATA
//
// DATA ONLY. This produces the rows an alert would be built from; it sends
// nothing. Push/email/SMS delivery is a later notifications module and is
// deliberately absent — a read endpoint the frontend polls is the whole of the
// alerting surface in this task.
//
// THRESHOLD SOURCE: Product.minStockThreshold, the field the catalog already
// carries for reorder alerts (§6.4.1). It is applied PER LOCATION SLICE — the
// question an allocation admin asks is "which till is running out?", not "is the
// tenant running out" — and a threshold of ZERO means NO ALERT. Without that
// rule every product at every location it has never stocked would alarm
// permanently, and a feed that is always full is a feed nobody reads. A location
// hitting zero is separately a HARD STOP at the point of sale; that is the
// selling guard, not an alert.
// ---------------------------------------------------------------------------

export interface LowStockAlertRow {
  productId: string;
  sku: string;
  productName: string;
  locationId: string;
  locationCode: string;
  locationName: string;
  locationType: LocationType;
  /** What this location currently OWNS. */
  quantity: string;
  /** Product.minStockThreshold — the per-product reorder point, applied per slice. */
  threshold: string;
  /** threshold - quantity, never negative. */
  shortfall: string;
  reorderQuantity: string | null;
  /**
   * What to move to clear the alert: the reorder quantity when the catalog
   * states one, but never less than the shortfall — topping up by less than the
   * shortfall would leave the location still below its threshold.
   */
  suggestedTransferQty: string;
  /** What the MAIN pool currently owns, so the admin can see whether a top-up is even possible. */
  mainAvailable: string;
}

interface LowStockRawRow {
  product_id: string;
  sku: string;
  product_name: string;
  location_id: string;
  location_code: string;
  location_name: string;
  // The enum column comes back as its label. Declared as the enum type, the
  // same way LocationSliceRawRow in inventory.ts declares a raw Decimal/bigint:
  // the shape of a raw result is stated once, at the query.
  location_type: LocationType;
  quantity: string;
  threshold: string;
  reorder_qty: string | null;
  main_quantity: string;
}

export async function getLowStockAlerts(
  db: TenantPrismaClient,
): Promise<LowStockAlertRow[]> {
  const schema = resolveSchema(db);

  // Schema-qualified throughout: the pg adapter does not set search_path, so an
  // unqualified name would silently resolve against public (the engineering ledger, "Raw SQL
  // and Tenant Schema Resolution").
  const rows = await db.$queryRawUnsafe<LowStockRawRow[]>(
    `SELECT p."id"                     AS product_id,
            p."sku"                    AS sku,
            p."name"                   AS product_name,
            l."id"                     AS location_id,
            l."code"                   AS location_code,
            l."name"                   AS location_name,
            l."type"                   AS location_type,
            pls."quantity"::text       AS quantity,
            p."minStockThreshold"::text AS threshold,
            p."reorderQuantity"::text  AS reorder_qty,
            COALESCE((
              SELECT mpls."quantity"
              FROM "${schema}".product_location_stock mpls
              JOIN "${schema}".locations ml ON ml."id" = mpls."locationId"
              WHERE mpls."productId" = p."id" AND ml."isDefault" = true
            ), 0)::text                AS main_quantity
     FROM "${schema}".product_location_stock pls
     JOIN "${schema}".products  p ON p."id" = pls."productId"
     JOIN "${schema}".locations l ON l."id" = pls."locationId"
     WHERE l."isActive" = true
       AND p."isActive" = true
       AND p."minStockThreshold" > 0
       AND pls."quantity" <= p."minStockThreshold"
     ORDER BY l."code" ASC, p."sku" ASC`,
  );

  return rows.map((row) => {
    const quantityMilli = decimalToMilli(row.quantity);
    const thresholdMilli = decimalToMilli(row.threshold);
    const shortfallMilli =
      thresholdMilli > quantityMilli ? thresholdMilli - quantityMilli : 0n;
    const reorderMilli = row.reorder_qty === null ? null : decimalToMilli(row.reorder_qty);
    const suggestedMilli =
      reorderMilli !== null && reorderMilli > shortfallMilli ? reorderMilli : shortfallMilli;

    return {
      productId: row.product_id,
      sku: row.sku,
      productName: row.product_name,
      locationId: row.location_id,
      locationCode: row.location_code,
      locationName: row.location_name,
      locationType: row.location_type,
      quantity: milliToDecimalString(quantityMilli),
      threshold: milliToDecimalString(thresholdMilli),
      shortfall: milliToDecimalString(shortfallMilli),
      reorderQuantity: reorderMilli === null ? null : milliToDecimalString(reorderMilli),
      suggestedTransferQty: milliToDecimalString(suggestedMilli),
      mainAvailable: milliToDecimalString(decimalToMilli(row.main_quantity)),
    };
  });
}
