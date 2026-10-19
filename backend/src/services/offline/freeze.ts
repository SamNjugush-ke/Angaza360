// ===========================================================================
// LEASE EXPIRY -> FREEZE, AND THE TWO WAYS A FREEZE RESOLVES (Task OFF.1).
//
// THIS IS THE ONLY MODULE PERMITTED TO WRITE THE `stock_freezes` TABLE. It
// writes NO STOCK TABLE AT ALL and NEVER posts to the ledger directly: every
// stock effect below — immobilising a location's slices, thawing them,
// transferring a remainder back to MAIN, writing frozen stock off — is performed
// by src/services/inventory.ts, which remains the sole stock writer and the sole
// caller of the ledger for stock. This module decides WHETHER and WHEN; it never
// decides HOW.
//
// ---------------------------------------------------------------------------
// WHAT A FREEZE IS, AND WHY IT POSTS NOTHING
//
// A lease expired and the device never synced. The server therefore DOES NOT
// KNOW what that device sold. The engineering ledger's rule is absolute: it must not guess.
// So the location's remaining owned stock is IMMOBILISED —
//
//   * REMOVED from the location's sellable allocation, so a device that
//     reconnects cannot keep selling on a dead lease;
//   * NOT RETURNED to MAIN's sellable pool, because returning stock the device
//     may already have sold would let another channel oversell it;
//   * and NO JOURNAL ENTRY IS POSTED, because no value entered or left the
//     entity. The goods are still the tenant's, still counted in
//     Product.stockCount, still carried in Product.stockValue and still in GL
//     1200. Only their SELLABILITY changed, and sellability is not a financial
//     event. Posting anything here would in fact BREAK
//     sum(Product.stockValue) = GL(1200).
//
// Mechanically that is product_location_stock.frozenQuantity := quantity, and
// SELLABLE = quantity - frozenQuantity everywhere in the inventory service.
//
// ---------------------------------------------------------------------------
// THE ONLY TWO EXITS
//
//   (a) THE DEVICE EVENTUALLY SYNCS. The truth arrives: its real sales post at
//       their real business dates, and the genuinely unsold remainder returns to
//       MAIN. Automatic, nobody decides anything — which is why the resolution
//       records no resolvedBy. Orchestrated by src/services/offline/sync.ts
//       through thawForSync / releaseFreezeAfterSync below.
//
//   (b) AN ADMIN WRITES IT OFF, for a genuinely lost, stolen or dead device. The
//       frozen quantity posts as an inventory loss, Dr 5300 Inventory Write-offs
//       / Cr 1200 Inventory, at carrying value. THIS IS THE ONLY PATH BY WHICH
//       FROZEN STOCK BECOMES A GENERAL-LEDGER EVENT, and it is always an explicit
//       human decision with a name attached.
//
// The worst case is therefore a business decision, never a corrupted book.
// ===========================================================================

import type { PrismaClient as TenantPrismaClient } from "../../generated/tenant/client";
import type { FreezeStatus } from "../../generated/tenant/enums";
import { assertValidSchemaName, tenantSchemaFor } from "../../db/tenant";
import { decimalToMilli } from "../../lib/inventory-math";
import type { Cents } from "../../lib/money";
import {
  freezeLocationStockWithinTransaction,
  getFrozenStockAtLocation,
  getOwnedStockAtLocationWithinTransaction,
  thawLocationStockWithinTransaction,
  transferStockWithinTransaction,
  withInventoryErrorTranslation,
  writeOffFrozenStockWithinTransaction,
  type FrozenSliceRow,
} from "../inventory";
import { endLeaseWithinTransaction, findExpiredUnsyncedDevices } from "./custody";

/**
 * The actor recorded on the movements a SYNC RELEASE produces. It is not a
 * platform user id because no user decided anything: the device reported what it
 * had sold and the arithmetic did the rest. A write-off, by contrast, always
 * carries the admin's real user id — an accounting loss must name its decider.
 */
const SYNC_ACTOR = "offline-sync";

/** Bad input (unknown device/location). Route -> 400. */
export class FreezeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FreezeValidationError";
  }
}

/** No active freeze to act on, or it is already resolved. Route -> 409. */
export class FreezeStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FreezeStateError";
  }
}

function resolveSchema(db: TenantPrismaClient): string {
  const schema = tenantSchemaFor(db);
  assertValidSchemaName(schema);
  return schema;
}

export interface FreezeRow {
  id: string;
  deviceId: string;
  deviceName: string;
  locationId: string;
  locationCode: string;
  locationName: string;
  status: FreezeStatus;
  leaseExpiredAt: Date;
  frozenAt: Date;
  productCount: number;
  resolvedAt: Date | null;
  /** NULL on a sync release: nobody decided it. Always set on a write-off. */
  resolvedBy: string | null;
  resolutionNote: string | null;
}

interface FreezeWithRelations {
  id: string;
  deviceId: string;
  locationId: string;
  status: FreezeStatus;
  leaseExpiredAt: Date;
  frozenAt: Date;
  productCount: number;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  device: { deviceName: string };
  location: { code: string; name: string };
}

const FREEZE_INCLUDE = {
  device: { select: { deviceName: true } },
  location: { select: { code: true, name: true } },
} as const;

function toRow(freeze: FreezeWithRelations): FreezeRow {
  return {
    id: freeze.id,
    deviceId: freeze.deviceId,
    deviceName: freeze.device.deviceName,
    locationId: freeze.locationId,
    locationCode: freeze.location.code,
    locationName: freeze.location.name,
    status: freeze.status,
    leaseExpiredAt: freeze.leaseExpiredAt,
    frozenAt: freeze.frozenAt,
    productCount: freeze.productCount,
    resolvedAt: freeze.resolvedAt,
    resolvedBy: freeze.resolvedBy,
    resolutionNote: freeze.resolutionNote,
  };
}

// ---------------------------------------------------------------------------
// 1. THE SWEEP — expire leases and freeze what they held
// ---------------------------------------------------------------------------

export type ExpireOutcome = "FROZEN" | "ALREADY_FROZEN" | "NOTHING_TO_FREEZE";

export interface ExpireLeaseResult {
  deviceId: string;
  deviceName: string;
  locationId: string;
  locationCode: string;
  /** The lease expiry instant this sweep acted on. */
  leaseExpiresAt: Date;
  outcome: ExpireOutcome;
  /** The freeze row, for FROZEN and ALREADY_FROZEN. */
  freezeId: string | null;
  /** What was immobilised by THIS call. Empty unless the outcome is FROZEN. */
  frozen: FrozenSliceRow[];
}

export interface ExpireLeasesResult {
  checkedAt: Date;
  results: ExpireLeaseResult[];
  frozenCount: number;
}

/**
 * Freeze the allocation of every ACTIVE device whose lease has expired without
 * syncing. Idempotent: a second run finds nothing, because each device's lease is
 * ENDED as part of its freeze, and because a location that already carries an
 * active freeze is left alone.
 *
 * Each device is handled in its OWN transaction, so one tenant's odd device cannot
 * block the rest of the sweep, and the freeze + the lease-end + the freeze record
 * land together or not at all.
 *
 * WHY THE LEASE IS ENDED HERE: the window is over. Leaving leaseExpiresAt in the
 * past would make this sweep re-find the same device forever, and — more
 * importantly — the device must not be able to keep selling on it. The expiry
 * instant is not lost: it is recorded on the freeze row as leaseExpiredAt, which
 * is where the audit question "which lease did this freeze come from?" is
 * answered. A device whose stock has been frozen must take custody again (a new
 * lease) before it can sell, and it cannot do that until the freeze resolves,
 * because its location holds nothing sellable.
 *
 * NOTHING_TO_FREEZE is a real and common outcome: a till that sold its entire
 * allocation and then went flat owns nothing, so there is nothing to immobilise.
 * No freeze row is written for it (migration 0015 requires productCount > 0 — a
 * freeze over nothing is not a freeze) and its lease is simply ended.
 */
export async function expireLeases(
  db: TenantPrismaClient,
  now: Date = new Date(),
): Promise<ExpireLeasesResult> {
  const schema = resolveSchema(db);
  const candidates = await findExpiredUnsyncedDevices(db, now);

  const results: ExpireLeaseResult[] = [];
  for (const candidate of candidates) {
    const result = await withInventoryErrorTranslation(() =>
      db.$transaction(async (tx) => {
        // Re-read the device under a row lock. Between the candidate scan and
        // here the device may have synced (which resolves the question honestly)
        // or another worker may have expired it already.
        const locked = await tx.$queryRawUnsafe<
          Array<{ lease_expires_at: Date | null; last_sync_at: Date | null }>
        >(
          `SELECT "leaseExpiresAt" AS lease_expires_at, "lastSyncAt" AS last_sync_at
           FROM "${schema}".pos_devices WHERE "id" = $1 FOR UPDATE`,
          candidate.deviceId,
        );
        const device = locked[0];
        if (
          device === undefined ||
          device.lease_expires_at === null ||
          device.lease_expires_at.getTime() >= now.getTime() ||
          (device.last_sync_at !== null &&
            device.last_sync_at.getTime() >= device.lease_expires_at.getTime())
        ) {
          return null;
        }

        const existing = await tx.stockFreeze.findFirst({
          where: { locationId: candidate.locationId, status: "PENDING_RECONCILIATION" },
        });
        if (existing !== null) {
          // The location's stock is already immobilised — by this device's earlier
          // expiry or by a second device sharing the location. Nothing more to
          // freeze; just close this device's window.
          await endLeaseWithinTransaction(tx, candidate.deviceId);
          const row: ExpireLeaseResult = {
            ...candidate,
            outcome: "ALREADY_FROZEN",
            freezeId: existing.id,
            frozen: [],
          };
          return row;
        }

        const frozen = await freezeLocationStockWithinTransaction(
          tx,
          schema,
          candidate.locationId,
        );
        await endLeaseWithinTransaction(tx, candidate.deviceId);

        if (frozen.length === 0) {
          const row: ExpireLeaseResult = {
            ...candidate,
            outcome: "NOTHING_TO_FREEZE",
            freezeId: null,
            frozen: [],
          };
          return row;
        }

        const created = await tx.stockFreeze.create({
          data: {
            deviceId: candidate.deviceId,
            locationId: candidate.locationId,
            status: "PENDING_RECONCILIATION",
            leaseExpiredAt: candidate.leaseExpiresAt,
            productCount: frozen.length,
          },
        });
        const row: ExpireLeaseResult = {
          ...candidate,
          outcome: "FROZEN",
          freezeId: created.id,
          frozen,
        };
        return row;
      }),
    );

    if (result !== null) {
      results.push(result);
    }
  }

  return {
    checkedAt: now,
    results,
    frozenCount: results.filter((row) => row.outcome === "FROZEN").length,
  };
}

// ---------------------------------------------------------------------------
// 2. Reads
// ---------------------------------------------------------------------------

export async function getActiveFreezeForLocation(
  db: TenantPrismaClient,
  locationId: string,
): Promise<FreezeRow | null> {
  const freeze = await db.stockFreeze.findFirst({
    where: { locationId, status: "PENDING_RECONCILIATION" },
    include: FREEZE_INCLUDE,
  });
  return freeze === null ? null : toRow(freeze);
}

export interface FreezeDetail extends FreezeRow {
  /** What is immobilised right now. Empty once the freeze has resolved. */
  frozen: FrozenSliceRow[];
}

export async function listFreezes(
  db: TenantPrismaClient,
  filters: { status?: FreezeStatus; deviceId?: string } = {},
): Promise<FreezeRow[]> {
  const rows = await db.stockFreeze.findMany({
    where: {
      ...(filters.status !== undefined ? { status: filters.status } : {}),
      ...(filters.deviceId !== undefined ? { deviceId: filters.deviceId } : {}),
    },
    include: FREEZE_INCLUDE,
    orderBy: { frozenAt: "desc" },
  });
  return rows.map(toRow);
}

/** Every live freeze, with the per-product detail of what it holds. The admin's alert feed. */
export async function listActiveFreezeDetails(
  db: TenantPrismaClient,
): Promise<FreezeDetail[]> {
  const freezes = await listFreezes(db, { status: "PENDING_RECONCILIATION" });
  const details: FreezeDetail[] = [];
  for (const freeze of freezes) {
    details.push({ ...freeze, frozen: await getFrozenStockAtLocation(db, freeze.locationId) });
  }
  return details;
}

// ---------------------------------------------------------------------------
// 3. RESOLUTION (a) — THE DEVICE SYNCS
//
// Three small steps, called by src/services/offline/sync.ts around the replay,
// rather than one function, because the replay in the middle is the sync
// service's job and must stay there.
// ---------------------------------------------------------------------------

export interface ThawForSyncResult {
  freezeId: string;
  locationId: string;
  /** What was immobilised, captured BEFORE the thaw so the report can show it. */
  frozenBefore: FrozenSliceRow[];
}

/**
 * Step 1 of a sync release: make the frozen stock available again so the device's
 * REAL sales can draw from it.
 *
 * This is not a decision and not yet a resolution — the freeze row stays
 * PENDING_RECONCILIATION. It is the mechanical precondition for the truth to be
 * recorded: the sales the device actually made came out of exactly this stock, and
 * an outbound movement is checked against SELLABLE. Refusing to thaw would mean
 * refusing to record sales that genuinely happened, which is the one thing worse
 * than freezing.
 *
 * Returns null when the device's location holds no active freeze — the ordinary
 * case for a healthy device, where sync needs none of this.
 */
export async function thawForSync(
  db: TenantPrismaClient,
  locationId: string,
): Promise<ThawForSyncResult | null> {
  const schema = resolveSchema(db);

  return db.$transaction(async (tx) => {
    const freeze = await tx.stockFreeze.findFirst({
      where: { locationId, status: "PENDING_RECONCILIATION" },
    });
    if (freeze === null) {
      return null;
    }
    const frozenBefore = await getOwnedStockAtLocationWithinTransaction(tx, schema, locationId);
    await thawLocationStockWithinTransaction(tx, schema, locationId);
    return {
      freezeId: freeze.id,
      locationId,
      frozenBefore: frozenBefore.filter((slice) => decimalToMilli(slice.frozenQuantity) > 0n),
    };
  });
}

export interface FreezeReleaseResult {
  freezeId: string;
  /** What went back to MAIN as genuinely unsold. */
  returned: Array<{ productId: string; sku: string; quantity: string }>;
  freeze: FreezeRow;
}

/**
 * Step 2 of a sync release: the genuinely unsold remainder goes back to MAIN and
 * the freeze is marked RELEASED_BY_SYNC.
 *
 * "The genuinely unsold remainder" is whatever the location still owns AFTER the
 * device's real sales have posted — that is the whole point of replaying the sales
 * first. The return is a VALUE-NEUTRAL TRANSFER through the inventory service, so
 * it posts no journal entry, leaves Product.stockCount / stockValue / avgCost
 * untouched, and writes the usual immutable TRANSFER_OUT / TRANSFER_IN pair.
 * sum(Product.stockValue) = GL(1200) therefore holds across the release for
 * exactly the same reason it holds across every other transfer.
 *
 * The device's lease is ended too: it handed everything in, so it holds custody of
 * nothing and must take a fresh lease before it sells again.
 *
 * resolvedBy is deliberately NOT set. Nobody made a decision here — the device
 * reported what it had sold and the arithmetic did the rest. Migration 0015's
 * stock_freeze_resolution_consistent CHECK encodes that: only a WRITTEN_OFF row
 * may name a decider.
 */
export async function releaseFreezeAfterSync(
  db: TenantPrismaClient,
  freezeId: string,
): Promise<FreezeReleaseResult> {
  const schema = resolveSchema(db);

  return withInventoryErrorTranslation(() =>
    db.$transaction(async (tx) => {
      const freeze = await tx.stockFreeze.findUnique({
        where: { id: freezeId },
        include: FREEZE_INCLUDE,
      });
      if (freeze === null) {
        throw new FreezeValidationError(`Unknown stock freeze ${freezeId}.`);
      }
      if (freeze.status !== "PENDING_RECONCILIATION") {
        throw new FreezeStateError(
          `Stock freeze ${freezeId} is already ${freeze.status}; it cannot be released again.`,
        );
      }

      const main = await tx.location.findFirst({ where: { isDefault: true } });
      if (main === null) {
        throw new FreezeValidationError(
          "No default (MAIN) location is configured for this tenant, so an unsold remainder has nowhere to return to.",
        );
      }

      const remainder = await getOwnedStockAtLocationWithinTransaction(
        tx,
        schema,
        freeze.locationId,
      );

      const returned: Array<{ productId: string; sku: string; quantity: string }> = [];
      for (const slice of remainder) {
        if (decimalToMilli(slice.ownedQuantity) <= 0n) {
          continue;
        }
        const transfer = await transferStockWithinTransaction(tx, schema, {
          productId: slice.productId,
          fromLocationId: freeze.locationId,
          toLocationId: main.id,
          quantity: slice.ownedQuantity,
          reference: "LEASE_SYNC_RELEASE",
          notes: `Unsold remainder returned to MAIN after device ${freeze.device.deviceName} synced (freeze ${freezeId})`,
          createdBy: SYNC_ACTOR,
        });
        returned.push({
          productId: transfer.productId,
          sku: transfer.sku,
          quantity: transfer.quantity,
        });
      }

      await endLeaseWithinTransaction(tx, freeze.deviceId);

      const resolved = await tx.stockFreeze.update({
        where: { id: freezeId },
        data: {
          status: "RELEASED_BY_SYNC",
          resolvedAt: new Date(),
          resolutionNote: `Device synced; ${returned.length.toString()} product(s) returned to ${main.code}.`,
        },
        include: FREEZE_INCLUDE,
      });

      return { freezeId, returned, freeze: toRow(resolved) };
    }),
  );
}

/**
 * Step 2-alternative: the sync did NOT fully account for the freeze, so the stock
 * goes straight back to frozen and the freeze STAYS PENDING_RECONCILIATION.
 *
 * This runs when any capture in the batch landed in NEEDS_RESOLUTION. Those
 * captures are sales that genuinely happened and have NOT yet posted, so some of
 * the stock still sitting at the location is already spoken for. Returning it to
 * MAIN now would be the auto-return the engineering ledger forbids — only worse, because we
 * would be doing it while holding written evidence that the stock was sold. So the
 * freeze is re-applied and the owner's queue is left to clear.
 */
export async function refreezeAfterIncompleteSync(
  db: TenantPrismaClient,
  freezeId: string,
): Promise<FrozenSliceRow[]> {
  const schema = resolveSchema(db);

  return withInventoryErrorTranslation(() =>
    db.$transaction(async (tx) => {
      const freeze = await tx.stockFreeze.findUnique({ where: { id: freezeId } });
      if (freeze === null) {
        throw new FreezeValidationError(`Unknown stock freeze ${freezeId}.`);
      }
      if (freeze.status !== "PENDING_RECONCILIATION") {
        throw new FreezeStateError(
          `Stock freeze ${freezeId} is already ${freeze.status}; it cannot be re-applied.`,
        );
      }
      return freezeLocationStockWithinTransaction(tx, schema, freeze.locationId);
    }),
  );
}

// ---------------------------------------------------------------------------
// 4. RESOLUTION (b) — THE ADMIN WRITE-OFF
// ---------------------------------------------------------------------------

export interface WriteOffResult {
  freeze: FreezeRow;
  movements: Array<{
    movementId: string;
    productId: string;
    quantity: string;
    totalCost: Cents;
    journalEntryId: string | null;
  }>;
  /** The total posted to 5300 Inventory Write-offs by this write-off, in cents. */
  totalWrittenOff: Cents;
}

/**
 * ONE-CLICK ADMIN WRITE-OFF of a frozen allocation — for a device that is
 * genuinely lost, stolen or dead and is never going to sync.
 *
 * THIS IS THE ONLY PLACE FROZEN STOCK BECOMES A GENERAL-LEDGER EVENT. One
 * WRITE_OFF movement per frozen product slice, each posting Dr 5300 Inventory
 * Write-offs / Cr 1200 Inventory at the carrying value the valuation rules derive
 * — the ordinary outbound path through the inventory service, with no special
 * valuation and no new accounts. Because the credit to 1200 equals the reduction
 * in Product.stockValue (one valuation event per movement, Task 3.1-FIX),
 * sum(Product.stockValue) = GL(1200) still holds after the loss is taken.
 *
 * It is ONE TRANSACTION: the movements, the journal entries, the thaw and the
 * freeze's resolution all commit together, so there is no instant at which the
 * stock is written off but still frozen, or thawed but not yet written off.
 *
 * The admin's user id is mandatory and is recorded as resolvedBy — an accounting
 * loss always names the person who decided to take it, and migration 0015's
 * resolution CHECK enforces that only a WRITTEN_OFF row carries one.
 */
export async function writeOffFrozenStock(
  db: TenantPrismaClient,
  freezeId: string,
  reason: string,
  userId: string,
): Promise<WriteOffResult> {
  const schema = resolveSchema(db);
  const trimmedReason = reason.trim();
  if (trimmedReason === "") {
    throw new FreezeValidationError("reason is required: a write-off is a recorded business decision.");
  }

  return withInventoryErrorTranslation(() =>
    db.$transaction(async (tx) => {
      const freeze = await tx.stockFreeze.findUnique({ where: { id: freezeId } });
      if (freeze === null) {
        throw new FreezeValidationError(`Unknown stock freeze ${freezeId}.`);
      }
      if (freeze.status !== "PENDING_RECONCILIATION") {
        throw new FreezeStateError(
          `Stock freeze ${freezeId} is already ${freeze.status}; it cannot be written off.`,
        );
      }

      const movements = await writeOffFrozenStockWithinTransaction(
        tx,
        schema,
        freeze.locationId,
        "LEASE_WRITE_OFF",
        `Frozen allocation written off (freeze ${freezeId}): ${trimmedReason}`,
        userId,
      );
      if (movements.length === 0) {
        throw new FreezeStateError(
          `Stock freeze ${freezeId} holds no frozen stock to write off. If the device has since synced, the freeze was already released.`,
        );
      }

      let totalWrittenOff = 0n;
      for (const movement of movements) {
        totalWrittenOff += movement.totalCost;
      }

      const resolved = await tx.stockFreeze.update({
        where: { id: freezeId },
        data: {
          status: "WRITTEN_OFF",
          resolvedAt: new Date(),
          resolvedBy: userId,
          resolutionNote: trimmedReason,
        },
        include: FREEZE_INCLUDE,
      });

      return {
        freeze: toRow(resolved),
        movements: movements.map((movement) => ({
          movementId: movement.id,
          productId: movement.productId,
          quantity: movement.quantity,
          totalCost: movement.totalCost,
          journalEntryId: movement.journalEntryId,
        })),
        totalWrittenOff,
      };
    }),
  );
}
