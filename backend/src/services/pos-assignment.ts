// ===========================================================================
// CASHIER LOCATION ASSIGNMENT (M4.5 Wave 3, tenant migration 0035).
//
// A CASHIER sells from ONE location — the till the owner or manager assigned them to — and that is
// held HERE, in the backend, not by hiding a selector:
//   * a cashier with no assignment cannot open a shift (403);
//   * a cashier's shift opens AT their assigned location, and records it;
//   * a cashier's quote, sale and allocation request name their assigned location or nothing
//     (nothing means the assignment, never MAIN); anything else is 403;
//   * a reassignment takes effect at once: a shift opened at the old location can no longer ring
//     a sale — the cashier closes it and opens one at the new location.
// The database holds the same (`shift_location_guard`, `sale_assigned_location_guard`). OWNER and
// MANAGER are not restricted: they manage the locations. Offline sync is not touched: a capture is
// replayed from its DEVICE's location under the offline rules.
//
// This file is the ONLY writer of `cashier_location_assignments`. It writes no stock, sale, shift
// or journal table. It READS the platform users of the SESSION's own tenant to know who is a
// cashier there — never a tenant named by the request.
// ===========================================================================

import { platformDb } from "../db/platform";
import type { PrismaClient as TenantPrismaClient } from "../generated/tenant/client";
import type { UserRole } from "../generated/platform/client";

export class PosAssignmentForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PosAssignmentForbiddenError";
  }
}

export class PosAssignmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PosAssignmentValidationError";
  }
}

export class PosAssignmentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PosAssignmentNotFoundError";
  }
}

export interface AssignedLocation {
  id: string;
  code: string;
  name: string;
  type: string;
}

export interface CashierAssignmentView {
  userId: string;
  fullName: string;
  email: string;
  location: AssignedLocation | null;
  assignedBy: string | null;
  assignedAt: Date | null;
}

const LOCATION_SELECT = { id: true, code: true, name: true, type: true } as const;

const UNASSIGNED =
  "You have not been assigned a selling location yet. Ask your manager to assign you to a till before you open a shift.";

/** The caller who rings a sale: only a CASHIER is restricted. */
export interface PosActor {
  userId: string;
  role: UserRole;
}

export function isRestricted(actor: PosActor): boolean {
  return actor.role === "CASHIER";
}

/** The cashier's assigned location, or null. */
export async function assignmentOf(db: TenantPrismaClient, userId: string): Promise<AssignedLocation | null> {
  const row = await db.cashierLocationAssignment.findUnique({ where: { userId }, select: { location: { select: LOCATION_SELECT } } });
  return row?.location ?? null;
}

async function mainLocationId(db: TenantPrismaClient): Promise<string> {
  const main = await db.location.findFirst({ where: { isDefault: true }, select: { id: true } });
  if (main === null) throw new PosAssignmentValidationError("This business has no MAIN location.");
  return main.id;
}

/**
 * Where a shift opens. A cashier: their assignment (a named location must BE it), and the shift
 * is marked as opened under it. An owner or manager: the location named, else MAIN.
 */
export async function shiftLocationFor(
  db: TenantPrismaClient,
  actor: PosActor,
  requested: string | undefined,
): Promise<{ locationId: string; cashierAssigned: boolean }> {
  if (!isRestricted(actor)) {
    if (requested === undefined) return { locationId: await mainLocationId(db), cashierAssigned: false };
    const location = await db.location.findUnique({ where: { id: requested }, select: { isActive: true } });
    if (location === null || !location.isActive) throw new PosAssignmentValidationError(`No active location with id "${requested}".`);
    return { locationId: requested, cashierAssigned: false };
  }
  const assigned = await assignmentOf(db, actor.userId);
  if (assigned === null) throw new PosAssignmentForbiddenError(UNASSIGNED);
  if (requested !== undefined && requested !== assigned.id) {
    throw new PosAssignmentForbiddenError(`You may open a shift only at your assigned location, ${assigned.name}.`);
  }
  return { locationId: assigned.id, cashierAssigned: true };
}

/**
 * The location a cashier's quote, sale or allocation request is for: the assignment, which a named
 * location must equal. For a sale, the shift must also have been opened there — after a
 * reassignment the old shift is closed and a new one opened. Owners and managers: whatever they
 * named (undefined keeps the existing MAIN default).
 */
export async function sellingLocationFor(
  db: TenantPrismaClient,
  actor: PosActor,
  requested: string | undefined,
  shiftId?: string,
): Promise<string | undefined> {
  if (!isRestricted(actor)) return requested;
  const assigned = await assignmentOf(db, actor.userId);
  if (assigned === null) throw new PosAssignmentForbiddenError(UNASSIGNED);
  if (requested !== undefined && requested !== assigned.id) {
    throw new PosAssignmentForbiddenError(`You may sell only from your assigned location, ${assigned.name}.`);
  }
  if (shiftId !== undefined) {
    const shift = await db.shift.findUnique({ where: { id: shiftId }, select: { locationId: true, cashierId: true } });
    if (shift !== null && shift.cashierId === actor.userId && shift.locationId !== assigned.id) {
      throw new PosAssignmentForbiddenError(
        `You have been moved to ${assigned.name}. Close this shift and open a new one there before ringing a sale.`,
      );
    }
  }
  return assigned.id;
}

/** Active cashiers of THIS business (the session's tenant). */
async function tenantCashiers(tenantId: string) {
  return platformDb.user.findMany({
    where: { tenantId, role: "CASHIER", isActive: true },
    select: { id: true, fullName: true, email: true },
    orderBy: [{ fullName: "asc" }, { id: "asc" }],
  });
}

export async function listCashierAssignments(db: TenantPrismaClient, tenantId: string): Promise<CashierAssignmentView[]> {
  const [cashiers, rows] = await Promise.all([
    tenantCashiers(tenantId),
    db.cashierLocationAssignment.findMany({ select: { userId: true, assignedBy: true, assignedAt: true, location: { select: LOCATION_SELECT } } }),
  ]);
  const byUser = new Map(rows.map((row) => [row.userId, row]));
  return cashiers.map((cashier) => {
    const row = byUser.get(cashier.id);
    return {
      userId: cashier.id,
      fullName: cashier.fullName,
      email: cashier.email,
      location: row?.location ?? null,
      assignedBy: row?.assignedBy ?? null,
      assignedAt: row?.assignedAt ?? null,
    };
  });
}

/** Assign or reassign an active cashier of this business to an active, non-storefront location. */
export async function assignCashier(
  db: TenantPrismaClient,
  tenantId: string,
  input: { userId: string; locationId: string; assignedBy: string },
): Promise<CashierAssignmentView> {
  const cashier = await platformDb.user.findFirst({
    where: { id: input.userId, tenantId, role: "CASHIER", isActive: true },
    select: { id: true, fullName: true, email: true },
  });
  // Another business's user, a non-cashier or an inactive account: not found (the 14.1 rule).
  if (cashier === null) throw new PosAssignmentNotFoundError("No active cashier with that id in this business.");
  const location = await db.location.findUnique({ where: { id: input.locationId }, select: { isActive: true, type: true } });
  if (location === null || !location.isActive) throw new PosAssignmentValidationError("Choose an active location.");
  if (location.type === "ECOMMERCE") throw new PosAssignmentValidationError("A cashier cannot be assigned to a storefront location.");
  const row = await db.cashierLocationAssignment.upsert({
    where: { userId: cashier.id },
    create: { userId: cashier.id, locationId: input.locationId, assignedBy: input.assignedBy },
    update: { locationId: input.locationId, assignedBy: input.assignedBy, assignedAt: new Date() },
    select: { assignedBy: true, assignedAt: true, location: { select: LOCATION_SELECT } },
  });
  return { userId: cashier.id, fullName: cashier.fullName, email: cashier.email, location: row.location, assignedBy: row.assignedBy, assignedAt: row.assignedAt };
}

/** Remove a cashier's assignment: they can open no new shift until reassigned. */
export async function removeCashierAssignment(db: TenantPrismaClient, tenantId: string, userId: string): Promise<void> {
  const cashier = await platformDb.user.findFirst({ where: { id: userId, tenantId, role: "CASHIER" }, select: { id: true } });
  if (cashier === null) throw new PosAssignmentNotFoundError("No cashier with that id in this business.");
  await db.cashierLocationAssignment.deleteMany({ where: { userId } });
}
