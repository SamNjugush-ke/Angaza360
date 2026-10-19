// ===========================================================================
// LOCATION MANAGEMENT & PER-LOCATION LEASE POLICY (Module 10, Task 10.2).
//
// THIS IS THE ONLY MODULE PERMITTED TO WRITE THE `locations` TABLE. It writes no
// stock table at all: it never touches stock_movements, product_location_stock,
// Product.stockCount / stockValue / avgCost, or the ledger. Moving stock remains
// exclusively src/services/inventory.ts's job — a location's POLICY and a
// location's STOCK are deliberately different writers.
//
// ---------------------------------------------------------------------------
// THE LEASE SEAM — read this before adding anything here.
//
// This module STORES AND EXPOSES a location's lease/session policy. It does NOT
// enforce it. Nothing in this file (or anywhere else in Task 10.2) reads
// leaseWindowMinutes to expire an allocation, freeze stock to
// PENDING_RECONCILIATION, reclaim an unsynced lease, or write anything off.
//
// Lease ENFORCEMENT belongs to the OFFLINE SERVER FOUNDATION, the task that
// follows this one. It is the task that introduces the concepts this one has no
// honest way to represent: when a lease STARTS (a device taking custody), what
// "unsynced" means (there is no sync ingest yet), and therefore when a window
// has expired. Encoding an expiry rule now, against no device and no sync
// clock, would be a guess baked into live tenant config — precisely the thing
// the engineering ledger's "Lease & Freeze Safety" refuses. What is invariant and already
// settled is that expiry FREEZES rather than guesses; WHEN it happens is the
// per-location policy this module stores.
//
// Enabling enforcement later is additive — new rows and new state, not an ALTER
// across live financial data — because the policy columns it will read already
// exist here from today.
// ---------------------------------------------------------------------------
// ===========================================================================

import type { PrismaClient as TenantPrismaClient } from "../generated/tenant/client";
import type { LocationType } from "../generated/tenant/enums";
import { assertValidSchemaName, tenantSchemaFor } from "../db/tenant";
import { decimalToMilli, milliToDecimalString } from "../lib/inventory-math";

/** Bad input (unknown location, malformed code, incoherent policy). Route -> 400. */
export class LocationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocationValidationError";
  }
}

/** The location's current state forbids the operation (still holds stock). Route -> 409. */
export class LocationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocationStateError";
  }
}

/**
 * The lease window an OFFLINE-CAPABLE location gets when its admin does not
 * choose one: 8 hours, per the engineering ledger "Lease & Freeze Safety".
 *
 * Note the two distinct meanings this reconciles, because they are easy to
 * conflate: NULL in the column means FOREVER (this location never freezes) —
 * that is the DATA meaning, and it is what MAIN, ECOMMERCE and a permanent
 * branch warehouse carry. 480 is the POLICY default handed to an offline-capable
 * location whose creator expressed no preference. An admin who wants "forever"
 * on an offline-capable till says so explicitly by sending null.
 */
export const DEFAULT_LEASE_WINDOW_MINUTES = 480;

/** Location codes are short, uppercase, and stable — they appear in movement audit rows. */
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,23}$/;
const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export interface LocationRow {
  id: string;
  name: string;
  code: string;
  type: LocationType;
  isDefault: boolean;
  isActive: boolean;
  isOfflineCapable: boolean;
  /** NULL means FOREVER — this location's allocation never freezes. */
  leaseWindowMinutes: number | null;
  sessionStart: string | null;
  sessionEnd: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface LocationRecord {
  id: string;
  name: string;
  code: string;
  type: LocationType;
  isDefault: boolean;
  isActive: boolean;
  isOfflineCapable: boolean;
  leaseWindowMinutes: number | null;
  sessionStart: string | null;
  sessionEnd: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toRow(location: LocationRecord): LocationRow {
  return {
    id: location.id,
    name: location.name,
    code: location.code,
    type: location.type,
    isDefault: location.isDefault,
    isActive: location.isActive,
    isOfflineCapable: location.isOfflineCapable,
    leaseWindowMinutes: location.leaseWindowMinutes,
    sessionStart: location.sessionStart,
    sessionEnd: location.sessionEnd,
    createdAt: location.createdAt,
    updatedAt: location.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Policy coherence. These mirror the CHECK constraints in migration 0013 one
// for one. Both exist on purpose: the CHECKs are the guarantee (they hold
// against psql, against a future module, against a bug here), and these are
// ergonomics that name the offending field instead of surfacing a constraint
// name. Neither replaces the other — see the engineering ledger "Working Practices".
// ---------------------------------------------------------------------------

interface PolicyShape {
  type: LocationType;
  isOfflineCapable: boolean;
  leaseWindowMinutes: number | null;
  sessionStart: string | null;
  sessionEnd: string | null;
}

function assertPolicyCoherent(policy: PolicyShape): void {
  if (
    (policy.type === "MAIN" || policy.type === "ECOMMERCE") &&
    policy.isOfflineCapable
  ) {
    throw new LocationValidationError(
      `A ${policy.type} location is never offline-capable: MAIN is the authoritative pool held by the server, and an e-commerce channel is server-side by definition.`,
    );
  }

  if (policy.leaseWindowMinutes !== null) {
    if (!policy.isOfflineCapable) {
      throw new LocationValidationError(
        "leaseWindowMinutes may only be set on an offline-capable location: a lease bounds how long a disconnected device may hold stock without syncing, so it has no meaning on a location that is always online.",
      );
    }
    if (!Number.isInteger(policy.leaseWindowMinutes) || policy.leaseWindowMinutes <= 0) {
      throw new LocationValidationError(
        "leaseWindowMinutes must be a positive whole number of minutes, or null for a lease that never expires.",
      );
    }
  }

  const startSet = policy.sessionStart !== null;
  const endSet = policy.sessionEnd !== null;
  if (startSet !== endSet) {
    throw new LocationValidationError(
      "sessionStart and sessionEnd must be set together or both left unset — a half-open daily window has no interpretation.",
    );
  }
  if (policy.sessionStart !== null && !TIME_PATTERN.test(policy.sessionStart)) {
    throw new LocationValidationError('sessionStart must be a 24-hour "HH:MM" time, e.g. "08:00".');
  }
  if (policy.sessionEnd !== null && !TIME_PATTERN.test(policy.sessionEnd)) {
    throw new LocationValidationError('sessionEnd must be a 24-hour "HH:MM" time, e.g. "18:00".');
  }
}

/**
 * Apply the policy DEFAULT for a lease window. Distinguishes "the caller said
 * nothing" (undefined -> 8 hours on an offline-capable location) from "the
 * caller chose forever" (null -> null). A location that cannot go offline never
 * gets a default window, because it can never hold a lease.
 */
function resolveLeaseWindow(
  requested: number | null | undefined,
  isOfflineCapable: boolean,
): number | null {
  if (requested !== undefined) {
    return requested;
  }
  return isOfflineCapable ? DEFAULT_LEASE_WINDOW_MINUTES : null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ListLocationFilters {
  type?: LocationType;
  activeOnly?: boolean;
}

export async function listLocations(
  db: TenantPrismaClient,
  filters: ListLocationFilters = {},
): Promise<LocationRow[]> {
  const locations = await db.location.findMany({
    where: {
      ...(filters.type !== undefined ? { type: filters.type } : {}),
      ...(filters.activeOnly === true ? { isActive: true } : {}),
    },
    orderBy: { code: "asc" },
  });
  return locations.map(toRow);
}

export async function getLocation(
  db: TenantPrismaClient,
  id: string,
): Promise<LocationRow | null> {
  const location = await db.location.findUnique({ where: { id } });
  return location === null ? null : toRow(location);
}

/**
 * The tenant's MAIN pool — the default source of every allocation and the
 * fallback location for an unstamped movement. Migration 0013 pins "default"
 * and "MAIN" to the same single row, so this lookup is unambiguous.
 */
export async function getMainLocation(db: TenantPrismaClient): Promise<LocationRow> {
  const main = await db.location.findFirst({ where: { isDefault: true } });
  if (main === null) {
    throw new LocationValidationError(
      "No default (MAIN) location is configured for this tenant. Provisioning seeds one; run npm run tenant:migrate-all.",
    );
  }
  return toRow(main);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface CreateLocationInput {
  name: string;
  code: string;
  type: LocationType;
  isOfflineCapable?: boolean;
  /** Omitted -> the 8-hour default on an offline-capable location. null -> forever. */
  leaseWindowMinutes?: number | null;
  sessionStart?: string | null;
  sessionEnd?: string | null;
}

export async function createLocation(
  db: TenantPrismaClient,
  input: CreateLocationInput,
): Promise<LocationRow> {
  const name = input.name.trim();
  if (name === "") {
    throw new LocationValidationError("name is required.");
  }

  const code = input.code.trim().toUpperCase();
  if (!CODE_PATTERN.test(code)) {
    throw new LocationValidationError(
      "code must be 1-24 characters of A-Z, 0-9, underscore or hyphen, starting with a letter or digit. It is stored uppercase and appears in stock movement audit rows.",
    );
  }

  // MAIN is not creatable. Exactly one exists per tenant, seeded by
  // provisioning, and migration 0013's partial unique index makes a second one
  // unrepresentable — refusing here turns that into a readable message instead
  // of a raw index violation.
  if (input.type === "MAIN") {
    throw new LocationValidationError(
      "A MAIN location cannot be created: every tenant has exactly one, seeded at provisioning, and it is the authoritative stock pool.",
    );
  }

  const isOfflineCapable = input.isOfflineCapable ?? false;
  const policy: PolicyShape = {
    type: input.type,
    isOfflineCapable,
    leaseWindowMinutes: resolveLeaseWindow(input.leaseWindowMinutes, isOfflineCapable),
    sessionStart: input.sessionStart ?? null,
    sessionEnd: input.sessionEnd ?? null,
  };
  assertPolicyCoherent(policy);

  const existing = await db.location.findUnique({ where: { code } });
  if (existing !== null) {
    throw new LocationValidationError(`A location with code "${code}" already exists.`);
  }

  const created = await db.location.create({
    data: {
      name,
      code,
      type: policy.type,
      // Never settable through the API: isDefault marks the single MAIN row.
      isDefault: false,
      isActive: true,
      isOfflineCapable: policy.isOfflineCapable,
      leaseWindowMinutes: policy.leaseWindowMinutes,
      sessionStart: policy.sessionStart,
      sessionEnd: policy.sessionEnd,
    },
  });
  return toRow(created);
}

export interface UpdateLocationInput {
  name?: string;
  type?: LocationType;
  isOfflineCapable?: boolean;
  /** Omitted -> unchanged. null -> forever (never freezes). */
  leaseWindowMinutes?: number | null;
  sessionStart?: string | null;
  sessionEnd?: string | null;
}

/**
 * Update a location's name and policy, INCLUDING its lease window — changing a
 * lease window is explicitly permitted, because enforcement is a later task and
 * the admin must be able to configure the policy before anything reads it.
 *
 * isActive is deliberately NOT updatable here: deactivation has a guard
 * (deactivateLocation) and must not be reachable by a plain field write.
 */
export async function updateLocation(
  db: TenantPrismaClient,
  id: string,
  input: UpdateLocationInput,
): Promise<LocationRow | null> {
  const existing = await db.location.findUnique({ where: { id } });
  if (existing === null) {
    return null;
  }

  // MAIN's identity is structural — the default location, the allocation source,
  // the fallback for an unstamped movement. Retyping it (or promoting another
  // location into it) would move all three at once.
  if (input.type !== undefined && input.type !== existing.type) {
    if (existing.type === "MAIN" || input.type === "MAIN") {
      throw new LocationValidationError(
        "A location's type cannot be changed to or from MAIN: MAIN is the tenant's single authoritative stock pool and the default source of every allocation.",
      );
    }
  }

  const nextName = input.name === undefined ? existing.name : input.name.trim();
  if (nextName === "") {
    throw new LocationValidationError("name must be a non-empty string.");
  }

  const nextType = input.type ?? existing.type;
  const nextOffline = input.isOfflineCapable ?? existing.isOfflineCapable;

  // A location losing offline capability loses its lease window with it: a lease
  // on an always-online location is meaningless config, and leaving a stale one
  // behind would be a setting that silently stops applying.
  let nextLease: number | null;
  if (input.leaseWindowMinutes !== undefined) {
    nextLease = input.leaseWindowMinutes;
  } else if (!nextOffline) {
    nextLease = null;
  } else {
    nextLease = existing.leaseWindowMinutes;
  }

  const policy: PolicyShape = {
    type: nextType,
    isOfflineCapable: nextOffline,
    leaseWindowMinutes: nextLease,
    sessionStart: input.sessionStart === undefined ? existing.sessionStart : input.sessionStart,
    sessionEnd: input.sessionEnd === undefined ? existing.sessionEnd : input.sessionEnd,
  };
  assertPolicyCoherent(policy);

  const updated = await db.location.update({
    where: { id },
    data: {
      name: nextName,
      type: policy.type,
      isOfflineCapable: policy.isOfflineCapable,
      leaseWindowMinutes: policy.leaseWindowMinutes,
      sessionStart: policy.sessionStart,
      sessionEnd: policy.sessionEnd,
    },
  });
  return toRow(updated);
}

export interface LocationDeactivationBlock {
  productId: string;
  sku: string;
  name: string;
  quantity: string;
}

interface OwnedStockRawRow {
  product_id: string;
  sku: string;
  product_name: string;
  quantity: string;
}

/**
 * Deactivate a location. REFUSED while the location still OWNS stock.
 *
 * This is the operational form of "every location owns its stock exclusively".
 * A deactivated location cannot be a transfer source (the inventory service
 * rejects an inactive source), so stock left behind on one would be stranded:
 * owned by a location that can no longer send it anywhere, still counted in
 * Product.stockCount, and therefore still carried in stockValue and in GL
 * account 1200 — inventory the business cannot sell but must still report. The
 * fix is not to relax this check; it is to transfer the stock out first, which
 * is one call to /v1/inventory/transfers.
 */
export async function deactivateLocation(
  db: TenantPrismaClient,
  id: string,
): Promise<LocationRow | null> {
  const schema = tenantSchemaFor(db);
  assertValidSchemaName(schema);

  const existing = await db.location.findUnique({ where: { id } });
  if (existing === null) {
    return null;
  }
  if (existing.isDefault || existing.type === "MAIN") {
    throw new LocationStateError(
      `Location ${existing.code} is the tenant's MAIN pool and cannot be deactivated: it is the default location every unstamped stock movement resolves to and the source of every allocation.`,
    );
  }
  if (!existing.isActive) {
    return toRow(existing);
  }

  // Schema-qualified: the pg adapter does not set search_path, so unqualified
  // raw SQL would silently resolve against public (the engineering ledger, "Raw SQL and
  // Tenant Schema Resolution").
  const held = await db.$queryRawUnsafe<OwnedStockRawRow[]>(
    `SELECT pls."productId"   AS product_id,
            p."sku"           AS sku,
            p."name"          AS product_name,
            pls."quantity"::text AS quantity
     FROM "${schema}".product_location_stock pls
     JOIN "${schema}".products p ON p.id = pls."productId"
     WHERE pls."locationId" = $1 AND pls."quantity" > 0
     ORDER BY p."sku" ASC`,
    id,
  );

  if (held.length > 0) {
    const summary = held
      .slice(0, 5)
      .map((row) => `${row.sku} x ${milliToDecimalString(decimalToMilli(row.quantity))}`)
      .join(", ");
    const more = held.length > 5 ? `, and ${(held.length - 5).toString()} more` : "";
    throw new LocationStateError(
      `Location ${existing.code} still owns stock and cannot be deactivated: ${summary}${more}. Transfer it out first (POST /v1/inventory/transfers) — deactivating would strand inventory that is still carried in Product.stockValue and GL account 1200.`,
    );
  }

  const updated = await db.location.update({ where: { id }, data: { isActive: false } });
  return toRow(updated);
}

/**
 * Reactivate a deactivated location. The symmetric counterpart to
 * deactivateLocation: without it, deactivation would be a one-way door and a
 * mis-click would permanently retire a till that still has history attached to
 * it (locations with movements can never be deleted — migration 0007's trigger).
 * Reactivating needs no guard, because an inactive location owns no stock.
 */
export async function activateLocation(
  db: TenantPrismaClient,
  id: string,
): Promise<LocationRow | null> {
  const existing = await db.location.findUnique({ where: { id } });
  if (existing === null) {
    return null;
  }
  if (existing.isActive) {
    return toRow(existing);
  }
  const updated = await db.location.update({ where: { id }, data: { isActive: true } });
  return toRow(updated);
}
