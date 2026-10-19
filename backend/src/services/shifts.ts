// ===========================================================================
// Cashier shift service (Task 3.2). A shift is a physical cash-drawer session:
// opening float, the sales rung on it, and a close that reconciles counted cash
// against expected. Opening/closing a shift posts NO journal entry — a float is
// a cash count, not a transaction. This service writes only the shifts table.
// ===========================================================================

import type { PrismaClient as TenantPrismaClient } from "../generated/tenant/client";
import type { Cents } from "../lib/money";
import type { ShiftStatus, TenderType } from "../generated/tenant/enums";

export class ShiftValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShiftValidationError";
  }
}

export interface ShiftSummary {
  id: string;
  cashierId: string;
  status: ShiftStatus;
  openingFloat: Cents;
  closingFloat: Cents | null;
  expectedCash: Cents | null;
  variance: Cents | null;
  openedAt: Date;
  closedAt: Date | null;
  saleCount: number;
  gross: Cents;
  tenderBreakdown: Record<TenderType, Cents>;
}

async function sumConfirmedTenders(
  db: TenantPrismaClient,
  shiftId: string,
  saleStatus: SaleStatusFilter,
  tenderType?: TenderType,
): Promise<Cents> {
  const result = await db.saleTender.aggregate({
    _sum: { amount: true },
    where: {
      status: "CONFIRMED",
      ...(tenderType !== undefined ? { tenderType } : {}),
      sale: { shiftId, status: saleStatus },
    },
  });
  return result._sum.amount ?? 0n;
}

type SaleStatusFilter = "COMPLETED" | "VOIDED";

async function buildSummary(
  db: TenantPrismaClient,
  shift: {
    id: string;
    cashierId: string;
    status: ShiftStatus;
    openingFloat: bigint;
    closingFloat: bigint | null;
    expectedCash: bigint | null;
    variance: bigint | null;
    openedAt: Date;
    closedAt: Date | null;
  },
): Promise<ShiftSummary> {
  const saleCount = await db.sale.count({ where: { shiftId: shift.id, status: "COMPLETED" } });
  const grossAgg = await db.sale.aggregate({
    _sum: { total: true },
    where: { shiftId: shift.id, status: "COMPLETED" },
  });

  const tenderTypes: TenderType[] = ["CASH", "MPESA", "BANK_TRANSFER", "CREDIT"];
  const tenderBreakdown = {} as Record<TenderType, Cents>;
  for (const type of tenderTypes) {
    tenderBreakdown[type] = await sumConfirmedTenders(db, shift.id, "COMPLETED", type);
  }

  return {
    id: shift.id,
    cashierId: shift.cashierId,
    status: shift.status,
    openingFloat: shift.openingFloat,
    closingFloat: shift.closingFloat,
    expectedCash: shift.expectedCash,
    variance: shift.variance,
    openedAt: shift.openedAt,
    closedAt: shift.closedAt,
    saleCount,
    gross: grossAgg._sum.total ?? 0n,
    tenderBreakdown,
  };
}

export async function openShift(
  db: TenantPrismaClient,
  cashierId: string,
  openingFloat: Cents,
): Promise<ShiftSummary> {
  if (openingFloat < 0n) {
    throw new ShiftValidationError("openingFloat must not be negative.");
  }
  const existing = await db.shift.findFirst({ where: { cashierId, status: "OPEN" } });
  if (existing !== null) {
    throw new ShiftValidationError(
      `Cashier already has an open shift (${existing.id}); close it before opening another.`,
    );
  }
  const shift = await db.shift.create({ data: { cashierId, openingFloat } });
  return buildSummary(db, shift);
}

export async function closeShift(
  db: TenantPrismaClient,
  shiftId: string,
  closingFloat: Cents,
  cashierId: string,
): Promise<ShiftSummary> {
  if (closingFloat < 0n) {
    throw new ShiftValidationError("closingFloat must not be negative.");
  }
  const shift = await db.shift.findUnique({ where: { id: shiftId } });
  if (shift === null) {
    throw new ShiftValidationError(`Shift ${shiftId} not found.`);
  }
  if (shift.cashierId !== cashierId) {
    throw new ShiftValidationError("This shift belongs to another cashier.");
  }
  if (shift.status === "CLOSED") {
    throw new ShiftValidationError("Shift is already closed.");
  }

  // expectedCash = openingFloat + CASH taken on completed sales - CASH refunded
  // on voided sales.
  const cashTaken = await sumConfirmedTenders(db, shiftId, "COMPLETED", "CASH");
  const cashRefunded = await sumConfirmedTenders(db, shiftId, "VOIDED", "CASH");
  const expectedCash = shift.openingFloat + cashTaken - cashRefunded;
  const variance = closingFloat - expectedCash;

  const updated = await db.shift.update({
    where: { id: shiftId },
    data: { closingFloat, expectedCash, variance, status: "CLOSED", closedAt: new Date() },
  });

  return buildSummary(db, updated);
}

export async function getShiftSummary(
  db: TenantPrismaClient,
  shiftId: string,
): Promise<ShiftSummary | null> {
  const shift = await db.shift.findUnique({ where: { id: shiftId } });
  if (shift === null) {
    return null;
  }
  return buildSummary(db, shift);
}

export async function getCurrentShift(
  db: TenantPrismaClient,
  cashierId: string,
): Promise<ShiftSummary | null> {
  const shift = await db.shift.findFirst({
    where: { cashierId, status: "OPEN" },
    orderBy: { openedAt: "desc" },
  });
  if (shift === null) {
    return null;
  }
  return buildSummary(db, shift);
}
