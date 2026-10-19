// ===========================================================================
// DEVICE REGISTRY & CUSTODY (Task OFF.1).
//
// THIS IS THE ONLY MODULE PERMITTED TO WRITE THE `pos_devices` TABLE. It writes
// no stock table, no sale table and no journal table: registering a device and
// starting a lease move nothing and post nothing. A device is a claim on a
// location's stock, not a stock operation.
//
// ---------------------------------------------------------------------------
// THIS IS THE SEAM Task 10.2 LEFT OPEN.
//
// 10.2 stored a per-location lease POLICY (isOfflineCapable,
// leaseWindowMinutes — NULL meaning FOREVER — and a session window) and
// deliberately enforced none of it, because enforcement needs two facts that
// task had no honest way to supply: when a lease STARTS, and what "unsynced"
// means. This module supplies the first. A DEVICE TAKES CUSTODY:
//
//     startLease(device)  ->  leaseStartedAt = now
//                             leaseExpiresAt = now + location.leaseWindowMinutes
//                                              (NULL window -> NULL expiry)
//
// A NULL expiry NEVER EXPIRES. That is the FOREVER lease the engineering ledger requires of a
// permanent branch warehouse, and it is why isLeaseExpired below tests for a
// non-null expiry first rather than treating NULL as "long ago".
//
// leaseExpiresAt is a SNAPSHOT of the policy at the moment custody was taken, not
// a live view of it. An admin editing the location's window afterwards changes
// what the NEXT lease will be and leaves live leases alone — the alternative would
// retroactively expire a device that is mid-shift through no fault of its own.
// ---------------------------------------------------------------------------
// ===========================================================================

import type { PrismaClient as TenantPrismaClient } from "../../generated/tenant/client";
import type { DeviceStatus, LocationType } from "../../generated/tenant/enums";
import { assertValidSchemaName, tenantSchemaFor } from "../../db/tenant";
import { businessPeriodEndExclusive } from "../../lib/business-time";
// Type-only: the transaction client's type. No runtime import of the ledger from
// here, so the ledger's own import of findDevicesBlockingPeriodClose below is not
// a cycle.
import type { LedgerTx } from "../ledger";

/** Bad input (unknown location, non-offline-capable location, blank name). Route -> 400. */
export class DeviceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceValidationError";
  }
}

/** The device's current state forbids the operation (retired, suspended). Route -> 409. */
export class DeviceStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceStateError";
  }
}

/**
 * A period cannot close because a device could still deliver sales dated inside
 * it. Route -> 409. Thrown by the ledger's closePeriod, which asks this module.
 */
export class PeriodCloseBlockedError extends Error {
  readonly devices: ReadonlyArray<BlockingDevice>;

  constructor(message: string, devices: ReadonlyArray<BlockingDevice>) {
    super(message);
    this.name = "PeriodCloseBlockedError";
    this.devices = devices;
  }
}

function resolveSchema(db: TenantPrismaClient): string {
  const schema = tenantSchemaFor(db);
  assertValidSchemaName(schema);
  return schema;
}

export interface DeviceRow {
  id: string;
  deviceName: string;
  locationId: string;
  locationCode: string;
  locationName: string;
  locationType: LocationType;
  /** The location's admin-set policy. NULL means FOREVER — this lease never expires. */
  locationLeaseWindowMinutes: number | null;
  status: DeviceStatus;
  leaseStartedAt: Date | null;
  /** leaseStartedAt + the window at the time custody was taken. NULL = forever. */
  leaseExpiresAt: Date | null;
  /** true when the device currently holds custody (a lease has been started and not ended). */
  holdsCustody: boolean;
  /** true only when a NON-NULL expiry is in the past. A forever lease is never expired. */
  leaseExpired: boolean;
  lastSyncAt: Date | null;
  registeredBy: string;
  createdAt: Date;
  updatedAt: Date;
}

interface DeviceWithLocation {
  id: string;
  deviceName: string;
  locationId: string;
  status: DeviceStatus;
  leaseStartedAt: Date | null;
  leaseExpiresAt: Date | null;
  lastSyncAt: Date | null;
  registeredBy: string;
  createdAt: Date;
  updatedAt: Date;
  location: {
    code: string;
    name: string;
    type: LocationType;
    leaseWindowMinutes: number | null;
  };
}

const DEVICE_INCLUDE = {
  location: { select: { code: true, name: true, type: true, leaseWindowMinutes: true } },
} as const;

/**
 * Has this device's lease expired?
 *
 * A NULL expiry is a FOREVER lease and NEVER expires — the test is deliberately
 * written so that "no expiry" cannot be mistaken for "expired long ago", because
 * that mistake would freeze a permanent branch warehouse's stock every night.
 */
export function isLeaseExpired(
  device: Pick<DeviceRow, "leaseExpiresAt">,
  now: Date = new Date(),
): boolean {
  return device.leaseExpiresAt !== null && device.leaseExpiresAt.getTime() < now.getTime();
}

function toRow(device: DeviceWithLocation): DeviceRow {
  const row: DeviceRow = {
    id: device.id,
    deviceName: device.deviceName,
    locationId: device.locationId,
    locationCode: device.location.code,
    locationName: device.location.name,
    locationType: device.location.type,
    locationLeaseWindowMinutes: device.location.leaseWindowMinutes,
    status: device.status,
    leaseStartedAt: device.leaseStartedAt,
    leaseExpiresAt: device.leaseExpiresAt,
    holdsCustody: device.leaseStartedAt !== null,
    leaseExpired: false,
    lastSyncAt: device.lastSyncAt,
    registeredBy: device.registeredBy,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
  };
  return { ...row, leaseExpired: isLeaseExpired(row) };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface RegisterDeviceInput {
  deviceName: string;
  locationId: string;
  registeredBy: string;
}

/**
 * Register a device against an OFFLINE-CAPABLE location.
 *
 * Refused for any location that cannot go offline — which by migration 0013
 * includes every MAIN and ECOMMERCE location, since neither may ever be
 * offline-capable. The reason is not bookkeeping: a device is the thing that can
 * go dark holding stock, and therefore the thing whose lease can expire and
 * freeze that stock. Attaching one to the tenant's authoritative pool would put
 * the pool itself at risk of freezing. Migration 0015's
 * pos_device_location_must_be_offline_capable trigger is the guarantee behind
 * this check; the check is what turns it into a readable message.
 */
export async function registerDevice(
  db: TenantPrismaClient,
  input: RegisterDeviceInput,
): Promise<DeviceRow> {
  const deviceName = input.deviceName.trim();
  if (deviceName === "") {
    throw new DeviceValidationError("deviceName is required.");
  }

  const location = await db.location.findUnique({ where: { id: input.locationId } });
  if (location === null) {
    throw new DeviceValidationError(`Unknown location ${input.locationId}.`);
  }
  if (!location.isActive) {
    throw new DeviceValidationError(
      `Location ${location.code} is deactivated and cannot serve a device.`,
    );
  }
  if (!location.isOfflineCapable) {
    throw new DeviceValidationError(
      `Location ${location.code} (${location.type}) is not offline-capable, so no device may take custody of its stock. ` +
        (location.type === "MAIN"
          ? "The MAIN location can never be offline-capable: it is the tenant's authoritative pool and is held by the server."
          : location.type === "ECOMMERCE"
            ? "An ECOMMERCE location can never be offline-capable: a storefront channel is server-side by definition and is always online."
            : `Set isOfflineCapable on ${location.code} first (PATCH /v1/locations/:id).`),
    );
  }

  const created = await db.posDevice.create({
    data: {
      deviceName,
      locationId: location.id,
      registeredBy: input.registeredBy,
    },
    include: DEVICE_INCLUDE,
  });
  return toRow(created);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ListDeviceFilters {
  locationId?: string;
  status?: DeviceStatus;
}

export async function listDevices(
  db: TenantPrismaClient,
  filters: ListDeviceFilters = {},
): Promise<DeviceRow[]> {
  const devices = await db.posDevice.findMany({
    where: {
      ...(filters.locationId !== undefined ? { locationId: filters.locationId } : {}),
      ...(filters.status !== undefined ? { status: filters.status } : {}),
    },
    include: DEVICE_INCLUDE,
    orderBy: { createdAt: "asc" },
  });
  return devices.map(toRow);
}

export async function getDevice(
  db: TenantPrismaClient,
  id: string,
): Promise<DeviceRow | null> {
  const device = await db.posDevice.findUnique({ where: { id }, include: DEVICE_INCLUDE });
  return device === null ? null : toRow(device);
}

// ---------------------------------------------------------------------------
// Custody — the lease clock
// ---------------------------------------------------------------------------

/**
 * THE DEVICE TAKES CUSTODY. Stamps leaseStartedAt = now and derives
 * leaseExpiresAt from the LOCATION's admin-set window:
 *
 *     window = N minutes  ->  leaseExpiresAt = now + N minutes
 *     window = NULL       ->  leaseExpiresAt = NULL, i.e. FOREVER, never freezes
 *
 * Renewing is the same operation: a renewal IS taking custody again, which is the
 * honest model — the clock restarts from the moment the device last proved it was
 * there, not from some earlier grant.
 *
 * A device may only take custody while ACTIVE. A SUSPENDED or RETIRED device is
 * refused with 409: it may still SYNC what it already captured (truth arriving is
 * never blocked), but it may not be handed a fresh window to sell in.
 *
 * Taking custody is NOT a stock operation. It moves nothing, reserves nothing and
 * posts nothing: the stock is already OWNED by the device's location — that is
 * what the allocation in Task 10.2 did — and this records that a device is now
 * answerable for it.
 */
export async function startLease(
  db: TenantPrismaClient,
  deviceId: string,
  now: Date = new Date(),
): Promise<DeviceRow> {
  const device = await db.posDevice.findUnique({ where: { id: deviceId }, include: DEVICE_INCLUDE });
  if (device === null) {
    throw new DeviceValidationError(`Unknown device ${deviceId}.`);
  }
  if (device.status !== "ACTIVE") {
    throw new DeviceStateError(
      `Device ${device.deviceName} is ${device.status} and cannot take custody of stock. It may still sync sales it has already captured.`,
    );
  }

  const windowMinutes = device.location.leaseWindowMinutes;
  const leaseExpiresAt =
    windowMinutes === null ? null : new Date(now.getTime() + windowMinutes * 60_000);

  const updated = await db.posDevice.update({
    where: { id: deviceId },
    data: { leaseStartedAt: now, leaseExpiresAt },
    include: DEVICE_INCLUDE,
  });
  return toRow(updated);
}

/** Renewing a lease IS taking custody again; same clock, restarted from now. */
export async function renewLease(
  db: TenantPrismaClient,
  deviceId: string,
  now: Date = new Date(),
): Promise<DeviceRow> {
  return startLease(db, deviceId, now);
}

/**
 * End custody deliberately: the device is back on the network, has handed in what
 * it had, and is no longer answerable for a window.
 *
 * This is the clean counterpart to expiry, and it is what makes a period
 * closeable: a device holding no custody can no longer be carrying unsynced sales
 * nobody has accounted for (see findDevicesBlockingPeriodClose). It moves no
 * stock — the location still owns whatever it owns — and posts nothing.
 */
export async function endLease(
  db: TenantPrismaClient,
  deviceId: string,
): Promise<DeviceRow> {
  const device = await db.posDevice.findUnique({ where: { id: deviceId } });
  if (device === null) {
    throw new DeviceValidationError(`Unknown device ${deviceId}.`);
  }
  const updated = await db.posDevice.update({
    where: { id: deviceId },
    data: { leaseStartedAt: null, leaseExpiresAt: null },
    include: DEVICE_INCLUDE,
  });
  return toRow(updated);
}

/**
 * Record that a sync batch from this device has arrived, inside the caller's
 * transaction. Written here rather than in the sync service because this module
 * is the sole writer of `pos_devices`.
 */
export async function markSyncedWithinTransaction(
  tx: LedgerTx,
  deviceId: string,
  at: Date,
): Promise<void> {
  await tx.posDevice.update({ where: { id: deviceId }, data: { lastSyncAt: at } });
}

/**
 * End custody inside the caller's transaction. Used by the freeze flow: an
 * expired lease is over, and by the sync release, after which the device must take
 * custody again before it can sell.
 */
export async function endLeaseWithinTransaction(
  tx: LedgerTx,
  deviceId: string,
): Promise<void> {
  await tx.posDevice.update({
    where: { id: deviceId },
    data: { leaseStartedAt: null, leaseExpiresAt: null },
  });
}

// ---------------------------------------------------------------------------
// THE PERIOD-CLOSE GUARD
// ---------------------------------------------------------------------------

export interface BlockingDevice {
  deviceId: string;
  deviceName: string;
  locationCode: string;
  leaseStartedAt: Date;
  /** NULL means a FOREVER lease — it will never expire on its own. */
  leaseExpiresAt: Date | null;
  lastSyncAt: Date | null;
}

interface BlockingDeviceRawRow {
  id: string;
  device_name: string;
  location_code: string;
  lease_started_at: Date;
  lease_expires_at: Date | null;
  last_sync_at: Date | null;
}

/**
 * Which devices still make period `year`-`month` unsafe to close.
 *
 * THE EXACT RULE IMPLEMENTED. A device blocks the close when ALL of:
 *
 *   1. `status = 'ACTIVE'` — a suspended or retired device is not out selling.
 *   2. It HOLDS LIVE CUSTODY: `leaseStartedAt IS NOT NULL` and the lease has not
 *      expired (`leaseExpiresAt IS NULL` — a FOREVER lease — or
 *      `leaseExpiresAt > now`).
 *   3. Its custody window OVERLAPS the period: `leaseStartedAt < endExclusive`.
 *      A lease that only began after the period ended cannot have captured a sale
 *      inside it.
 *   4. It has NOT SYNCED PAST the period: `lastSyncAt IS NULL OR lastSyncAt <
 *      endExclusive`. A device that has synced since the period ended has already
 *      delivered its outbox, so there is nothing of that period left on it.
 *
 * WHY LIVE CUSTODY AND NOT MERELY "EVER HELD IT". An ACTIVE lease is the case
 * where the server genuinely DOES NOT KNOW whether sales exist: the till is out
 * there, selling, and nobody has flagged anything. Closing over that would
 * falsify the period silently.
 *
 * An EXPIRED lease is a different situation, and the difference is the whole
 * design. Expiry FREEZES the location's stock to PENDING_RECONCILIATION and
 * raises it as something needing a decision (see src/services/offline/freeze.ts),
 * so what the device may be carrying is a KNOWN, VISIBLE, ALERTED condition rather
 * than an unknown. An owner who closes the period over the top of a flagged
 * freeze is making a business decision with their eyes open — and the sales, if
 * they ever arrive, are not lost: the CLOSED-PERIOD FALLBACK posts them into the
 * current open period with their true business date recorded on the sale
 * (originalBusinessDate). That is why ENDING or EXPIRING a lease unblocks the
 * close while the lease is live does not.
 *
 * `tx` is the caller's transaction, so the check and the close are atomic: a
 * device cannot take custody in the gap between them.
 */
export async function findDevicesBlockingPeriodClose(
  tx: LedgerTx,
  schema: string,
  year: number,
  month: number,
  now: Date = new Date(),
): Promise<BlockingDevice[]> {
  assertValidSchemaName(schema);
  // The first instant of the next month WHERE THE BUSINESS IS (Task H.1): custody and
  // syncs are compared with the period as Nairobi experiences it, the same calendar
  // the entries themselves are dated on.
  const endExclusive = businessPeriodEndExclusive(year, month);

  // Schema-qualified: the pg adapter does not set search_path, so an unqualified
  // name would silently resolve against public (the engineering ledger, "Raw SQL and Tenant
  // Schema Resolution").
  const rows = await tx.$queryRawUnsafe<BlockingDeviceRawRow[]>(
    `SELECT d."id"             AS id,
            d."deviceName"     AS device_name,
            l."code"           AS location_code,
            d."leaseStartedAt" AS lease_started_at,
            d."leaseExpiresAt" AS lease_expires_at,
            d."lastSyncAt"     AS last_sync_at
     FROM "${schema}".pos_devices d
     JOIN "${schema}".locations l ON l."id" = d."locationId"
     WHERE d."status" = 'ACTIVE'
       AND d."leaseStartedAt" IS NOT NULL
       AND (d."leaseExpiresAt" IS NULL OR d."leaseExpiresAt" > $1)
       AND d."leaseStartedAt" < $2
       AND (d."lastSyncAt" IS NULL OR d."lastSyncAt" < $2)
     ORDER BY d."deviceName" ASC`,
    now,
    endExclusive,
  );

  return rows.map((row) => ({
    deviceId: row.id,
    deviceName: row.device_name,
    locationCode: row.location_code,
    leaseStartedAt: row.lease_started_at,
    leaseExpiresAt: row.lease_expires_at,
    lastSyncAt: row.last_sync_at,
  }));
}

/**
 * Every device whose lease has expired and which has not synced since, with the
 * location it is answerable for. The freeze sweep's input.
 *
 * "Has not synced since" is `lastSyncAt IS NULL OR lastSyncAt < leaseExpiresAt`:
 * a device that synced after its window closed has already told the truth, so
 * there is nothing left to guess about and nothing to freeze.
 */
export interface ExpiredLeaseDevice {
  deviceId: string;
  deviceName: string;
  locationId: string;
  locationCode: string;
  leaseExpiresAt: Date;
}

interface ExpiredLeaseRawRow {
  id: string;
  device_name: string;
  location_id: string;
  location_code: string;
  lease_expires_at: Date;
}

export async function findExpiredUnsyncedDevices(
  db: TenantPrismaClient,
  now: Date = new Date(),
): Promise<ExpiredLeaseDevice[]> {
  const schema = resolveSchema(db);

  const rows = await db.$queryRawUnsafe<ExpiredLeaseRawRow[]>(
    `SELECT d."id"             AS id,
            d."deviceName"     AS device_name,
            d."locationId"     AS location_id,
            l."code"           AS location_code,
            d."leaseExpiresAt" AS lease_expires_at
     FROM "${schema}".pos_devices d
     JOIN "${schema}".locations l ON l."id" = d."locationId"
     WHERE d."status" = 'ACTIVE'
       AND d."leaseExpiresAt" IS NOT NULL
       AND d."leaseExpiresAt" < $1
       AND (d."lastSyncAt" IS NULL OR d."lastSyncAt" < d."leaseExpiresAt")
     ORDER BY d."leaseExpiresAt" ASC`,
    now,
  );

  return rows.map((row) => ({
    deviceId: row.id,
    deviceName: row.device_name,
    locationId: row.location_id,
    locationCode: row.location_code,
    leaseExpiresAt: row.lease_expires_at,
  }));
}
