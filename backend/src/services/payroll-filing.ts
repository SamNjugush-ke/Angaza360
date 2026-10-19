// ===========================================================================
// PAYROLL FILING OUTPUT — the payslip document, the statutory schedules and the
// muster roll (Module 8, Task 8.2).
//
// PURE READS. This file writes NOTHING — no payroll table, no settlement table, no
// journal table, no stock table.
//
// NO RECOMPUTATION. Every figure is read from the STORED payslip snapshot, which is
// frozen by migration 0021 the moment its run leaves DRAFT. Re-running the engine here
// would be a second opinion about a figure the business has already accrued and filed;
// if it ever disagreed, the document would contradict the ledger. The only arithmetic
// in this file is SUMMING stored columns into totals, in integer cents.
//
// EVERY SCHEDULE TIES TWO WAYS. Its total is checked against the payslip columns it was
// summed from AND against what the run's ACCRUAL ENTRY actually credited to that head
// (read straight off the posted journal lines). `reconciles` is true only when all three
// agree, so a schedule that does not match the books says so rather than filing a
// figure the ledger never recorded.
//
// MISSING IDENTIFIERS ARE FLAGGED, NOT FATAL. Task 8.1 let an employee be hired before
// their KRA PIN or NSSF/SHIF number is in hand, and recorded that FILING is where the
// absence becomes an error. It becomes one here as `fileable: false` plus a named list
// of who is missing what — the schedule is still produced, because an owner needs to
// see the figures to chase the numbers, but it is never presented as ready to submit.
// ===========================================================================

import type { PrismaClient as TenantPrismaClient } from "../generated/tenant/client";
import type {
  EmployeePaymentMethod,
  PayrollRunStatus,
  PayrollSettlementMethod,
} from "../generated/tenant/enums";
import type { Cents } from "../lib/money";
import {
  runHeadPositions,
  runNetAccrued,
  STATUTORY_AUTHORITY,
  type HeadPosition,
} from "./payroll-settlement";

export interface EmployerHeader {
  name: string;
  kraPin: string | null;
}

interface RawSlip {
  id: string;
  employeeId: string;
  grossPay: bigint;
  taxableGross: bigint;
  nssfEmployee: bigint;
  nssfEmployer: bigint;
  nssfTier1: bigint;
  nssfTier2: bigint;
  shifEmployee: bigint;
  ahlEmployee: bigint;
  ahlEmployer: bigint;
  taxablePay: bigint;
  payeBeforeRelief: bigint;
  personalReliefApplied: bigint;
  paye: bigint;
  totalEmployeeDeductions: bigint;
  netPay: bigint;
  employee: {
    employeeNumber: number;
    firstName: string;
    lastName: string;
    kraPin: string | null;
    nssfNumber: string | null;
    shifNumber: string | null;
  };
}

const SLIP_SELECT = {
  id: true,
  employeeId: true,
  grossPay: true,
  taxableGross: true,
  nssfEmployee: true,
  nssfEmployer: true,
  nssfTier1: true,
  nssfTier2: true,
  shifEmployee: true,
  ahlEmployee: true,
  ahlEmployer: true,
  taxablePay: true,
  payeBeforeRelief: true,
  personalReliefApplied: true,
  paye: true,
  totalEmployeeDeductions: true,
  netPay: true,
  employee: {
    select: {
      employeeNumber: true,
      firstName: true,
      lastName: true,
      kraPin: true,
      nssfNumber: true,
      shifNumber: true,
    },
  },
} as const;

function nameOf(slip: RawSlip): string {
  return `${slip.employee.firstName} ${slip.employee.lastName}`;
}

function sumOf(slips: ReadonlyArray<RawSlip>, pick: (slip: RawSlip) => bigint): Cents {
  return slips.reduce((sum, slip) => sum + pick(slip), 0n);
}

async function employerHeader(db: TenantPrismaClient, name: string): Promise<EmployerHeader> {
  // The business's own KRA PIN is tenant-authoritative business identity (Task 5.1's
  // BusinessProfile), read inside the tenant schema — never across to the platform
  // registry for anything a filing depends on.
  const profile = await db.businessProfile.findUnique({
    where: { id: "singleton" },
    select: { kraPin: true },
  });
  return { name, kraPin: profile?.kraPin ?? null };
}

// ---------------------------------------------------------------------------
// 1. The payslip document
// ---------------------------------------------------------------------------

export interface PayslipDocument {
  documentType: "PAYSLIP";
  employer: EmployerHeader;
  payslipId: string;
  run: {
    id: string;
    runNumber: number;
    periodYear: number;
    periodMonth: number;
    status: PayrollRunStatus;
    payDate: Date;
    statutoryScheduleLabel: string;
  };
  employee: {
    id: string;
    employeeNumber: number;
    name: string;
    nationalId: string | null;
    kraPin: string | null;
    nssfNumber: string | null;
    shifNumber: string | null;
  };
  earnings: Array<{ name: string; amount: Cents; taxable: boolean }>;
  grossPay: Cents;
  taxableGross: Cents;
  deductions: {
    nssf: Cents;
    nssfTier1: Cents;
    nssfTier2: Cents;
    shif: Cents;
    housingLevy: Cents;
    paye: Cents;
    total: Cents;
  };
  tax: {
    taxablePay: Cents;
    payeBeforeRelief: Cents;
    personalReliefApplied: Cents;
    paye: Cents;
  };
  netPay: Cents;
  employerContributions: {
    nssf: Cents;
    housingLevy: Cents;
    total: Cents;
  };
  payment: {
    status: "PAID" | "UNPAID";
    paymentDate: Date | null;
    settlementMethod: PayrollSettlementMethod | null;
    employeeMethod: EmployeePaymentMethod | null;
    amount: Cents | null;
  };
}

/**
 * Build one payslip as a structured JSON document — the payroll counterpart of the
 * sale receipt. The frontend renders and prints it; there is no PDF here.
 *
 * Earnings are the run-time SNAPSHOT (basic salary and each allowance as they stood
 * when the run was computed), never the employee's live terms. Identity — name, KRA
 * PIN, NSSF and SHIF numbers — is read from the employee record, because it is who the
 * person IS rather than what they were paid, and a corrected PIN should appear on a
 * reprint.
 */
export async function buildPayslipDocument(
  db: TenantPrismaClient,
  payslipId: string,
  employerName: string,
): Promise<PayslipDocument | null> {
  const slip = await db.payslip.findUnique({
    where: { id: payslipId },
    include: {
      earnings: true,
      employee: {
        select: {
          id: true,
          employeeNumber: true,
          firstName: true,
          lastName: true,
          nationalId: true,
          kraPin: true,
          nssfNumber: true,
          shifNumber: true,
        },
      },
      payrollRun: {
        select: {
          id: true,
          runNumber: true,
          periodYear: true,
          periodMonth: true,
          status: true,
          payDate: true,
          statutorySchedule: { select: { label: true } },
          netPayPayment: { select: { paymentDate: true, method: true } },
        },
      },
      netPayPaymentLine: { select: { amount: true, method: true } },
    },
  });
  if (slip === null) {
    return null;
  }

  // Basic Salary first, then allowances by name — the order a payslip is read in.
  const earnings = [...slip.earnings]
    .sort((a, b) => {
      if (a.name === "Basic Salary") return -1;
      if (b.name === "Basic Salary") return 1;
      return a.name.localeCompare(b.name);
    })
    .map((e) => ({ name: e.name, amount: e.amount, taxable: e.taxable }));

  const settlement = slip.payrollRun.netPayPayment;
  const line = slip.netPayPaymentLine;

  return {
    documentType: "PAYSLIP",
    employer: await employerHeader(db, employerName),
    payslipId: slip.id,
    run: {
      id: slip.payrollRun.id,
      runNumber: slip.payrollRun.runNumber,
      periodYear: slip.payrollRun.periodYear,
      periodMonth: slip.payrollRun.periodMonth,
      status: slip.payrollRun.status,
      payDate: slip.payrollRun.payDate,
      statutoryScheduleLabel: slip.payrollRun.statutorySchedule.label,
    },
    employee: {
      id: slip.employee.id,
      employeeNumber: slip.employee.employeeNumber,
      name: `${slip.employee.firstName} ${slip.employee.lastName}`,
      nationalId: slip.employee.nationalId,
      kraPin: slip.employee.kraPin,
      nssfNumber: slip.employee.nssfNumber,
      shifNumber: slip.employee.shifNumber,
    },
    earnings,
    grossPay: slip.grossPay,
    taxableGross: slip.taxableGross,
    deductions: {
      nssf: slip.nssfEmployee,
      nssfTier1: slip.nssfTier1,
      nssfTier2: slip.nssfTier2,
      shif: slip.shifEmployee,
      housingLevy: slip.ahlEmployee,
      paye: slip.paye,
      total: slip.totalEmployeeDeductions,
    },
    tax: {
      taxablePay: slip.taxablePay,
      payeBeforeRelief: slip.payeBeforeRelief,
      personalReliefApplied: slip.personalReliefApplied,
      paye: slip.paye,
    },
    netPay: slip.netPay,
    employerContributions: {
      nssf: slip.nssfEmployer,
      housingLevy: slip.ahlEmployer,
      total: slip.nssfEmployer + slip.ahlEmployer,
    },
    payment: {
      status: settlement === null ? "UNPAID" : "PAID",
      paymentDate: settlement?.paymentDate ?? null,
      settlementMethod: settlement?.method ?? null,
      employeeMethod: line?.method ?? null,
      amount: line?.amount ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// 2. The statutory schedules
// ---------------------------------------------------------------------------

export interface RunHeader {
  id: string;
  runNumber: number;
  periodYear: number;
  periodMonth: number;
  status: PayrollRunStatus;
  payDate: Date;
}

export interface MissingIdentifier {
  employeeId: string;
  employeeNumber: number;
  employeeName: string;
  field: "kraPin" | "nssfNumber" | "shifNumber";
}

/** The tie-out every schedule carries. */
export interface ScheduleTieOut {
  authority: string;
  accountCode: string;
  /** Σ of the schedule's amount column — what would be filed. */
  total: Cents;
  /** Σ of the corresponding payslip column(s), summed independently of the rows. */
  payslipTotal: Cents;
  /** What the run's accrual entry credited to the head. NULL before posting. */
  glCredited: Cents | null;
  /** Remittances tagged to this run for the head. */
  remitted: Cents;
  /** glCredited − remitted. NULL before posting. */
  outstanding: Cents | null;
  /** total == payslipTotal == glCredited. False before posting. */
  reconciles: boolean;
  missingIdentifiers: MissingIdentifier[];
}

export interface PayeScheduleRow {
  employeeId: string;
  employeeNumber: number;
  employeeName: string;
  kraPin: string | null;
  grossPay: Cents;
  taxablePay: Cents;
  payeBeforeRelief: Cents;
  personalReliefApplied: Cents;
  paye: Cents;
}

export interface NssfScheduleRow {
  employeeId: string;
  employeeNumber: number;
  employeeName: string;
  nssfNumber: string | null;
  grossPay: Cents;
  tier1: Cents;
  tier2: Cents;
  employee: Cents;
  employer: Cents;
  total: Cents;
}

export interface ShifScheduleRow {
  employeeId: string;
  employeeNumber: number;
  employeeName: string;
  shifNumber: string | null;
  grossPay: Cents;
  shif: Cents;
}

export interface HousingLevyScheduleRow {
  employeeId: string;
  employeeNumber: number;
  employeeName: string;
  kraPin: string | null;
  grossPay: Cents;
  employee: Cents;
  employer: Cents;
  total: Cents;
}

export interface StatutorySummary {
  employer: EmployerHeader;
  run: RunHeader;
  paye: ScheduleTieOut & {
    rows: PayeScheduleRow[];
    totals: { grossPay: Cents; taxablePay: Cents; payeBeforeRelief: Cents; personalReliefApplied: Cents; paye: Cents };
  };
  nssf: ScheduleTieOut & {
    rows: NssfScheduleRow[];
    totals: { grossPay: Cents; tier1: Cents; tier2: Cents; employee: Cents; employer: Cents; total: Cents };
  };
  shif: ScheduleTieOut & {
    rows: ShifScheduleRow[];
    totals: { grossPay: Cents; shif: Cents };
  };
  housingLevy: ScheduleTieOut & {
    rows: HousingLevyScheduleRow[];
    totals: { grossPay: Cents; employee: Cents; employer: Cents; total: Cents };
  };
  /** Σ of the four heads. */
  grandTotal: Cents;
  /** Every schedule reconciles AND no employee is missing an identifier it needs. */
  fileable: boolean;
}

function missing(
  slips: ReadonlyArray<RawSlip>,
  field: "kraPin" | "nssfNumber" | "shifNumber",
): MissingIdentifier[] {
  return slips
    .filter((slip) => {
      const value = slip.employee[field];
      return value === null || value.trim() === "";
    })
    .map((slip) => ({
      employeeId: slip.employeeId,
      employeeNumber: slip.employee.employeeNumber,
      employeeName: nameOf(slip),
      field,
    }));
}

function tieOut(
  position: HeadPosition,
  total: Cents,
  payslipTotal: Cents,
  missingIdentifiers: MissingIdentifier[],
): ScheduleTieOut {
  return {
    authority: STATUTORY_AUTHORITY[position.statutoryType],
    accountCode: position.accountCode,
    total,
    payslipTotal,
    glCredited: position.accrued,
    remitted: position.remitted,
    outstanding: position.outstanding,
    reconciles: position.accrued !== null && total === payslipTotal && total === position.accrued,
    missingIdentifiers,
  };
}

interface LoadedRun {
  header: RunHeader;
  journalEntryId: string | null;
  slips: RawSlip[];
}

async function loadRun(db: TenantPrismaClient, runId: string): Promise<LoadedRun | null> {
  const run = await db.payrollRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      runNumber: true,
      periodYear: true,
      periodMonth: true,
      status: true,
      payDate: true,
      journalEntryId: true,
      payslips: { select: SLIP_SELECT },
    },
  });
  if (run === null) {
    return null;
  }
  const slips = [...run.payslips].sort(
    (a, b) => a.employee.employeeNumber - b.employee.employeeNumber,
  );
  return {
    header: {
      id: run.id,
      runNumber: run.runNumber,
      periodYear: run.periodYear,
      periodMonth: run.periodMonth,
      status: run.status,
      payDate: run.payDate,
    },
    journalEntryId: run.journalEntryId,
    slips,
  };
}

/**
 * The four statutory schedules of one run — the data an employer files with KRA
 * (PAYE in the P10 shape, and the Housing Levy), NSSF and SHA. File FORMATS and direct
 * submission are deferred; this is the data they are generated from.
 */
export async function buildStatutorySummary(
  db: TenantPrismaClient,
  runId: string,
  employerName: string,
): Promise<StatutorySummary | null> {
  const loaded = await loadRun(db, runId);
  if (loaded === null) {
    return null;
  }
  const { slips } = loaded;
  const positions = await runHeadPositions(db, { id: loaded.header.id, journalEntryId: loaded.journalEntryId });

  // --- PAYE (the P10 shape) ---
  const payeRows: PayeScheduleRow[] = slips.map((slip) => ({
    employeeId: slip.employeeId,
    employeeNumber: slip.employee.employeeNumber,
    employeeName: nameOf(slip),
    kraPin: slip.employee.kraPin,
    grossPay: slip.grossPay,
    taxablePay: slip.taxablePay,
    payeBeforeRelief: slip.payeBeforeRelief,
    personalReliefApplied: slip.personalReliefApplied,
    paye: slip.paye,
  }));
  const payeTotals = {
    grossPay: payeRows.reduce((s, r) => s + r.grossPay, 0n),
    taxablePay: payeRows.reduce((s, r) => s + r.taxablePay, 0n),
    payeBeforeRelief: payeRows.reduce((s, r) => s + r.payeBeforeRelief, 0n),
    personalReliefApplied: payeRows.reduce((s, r) => s + r.personalReliefApplied, 0n),
    paye: payeRows.reduce((s, r) => s + r.paye, 0n),
  };

  // --- NSSF ---
  const nssfRows: NssfScheduleRow[] = slips.map((slip) => ({
    employeeId: slip.employeeId,
    employeeNumber: slip.employee.employeeNumber,
    employeeName: nameOf(slip),
    nssfNumber: slip.employee.nssfNumber,
    grossPay: slip.grossPay,
    tier1: slip.nssfTier1,
    tier2: slip.nssfTier2,
    employee: slip.nssfEmployee,
    employer: slip.nssfEmployer,
    total: slip.nssfEmployee + slip.nssfEmployer,
  }));
  const nssfTotals = {
    grossPay: nssfRows.reduce((s, r) => s + r.grossPay, 0n),
    tier1: nssfRows.reduce((s, r) => s + r.tier1, 0n),
    tier2: nssfRows.reduce((s, r) => s + r.tier2, 0n),
    employee: nssfRows.reduce((s, r) => s + r.employee, 0n),
    employer: nssfRows.reduce((s, r) => s + r.employer, 0n),
    total: nssfRows.reduce((s, r) => s + r.total, 0n),
  };

  // --- SHIF ---
  const shifRows: ShifScheduleRow[] = slips.map((slip) => ({
    employeeId: slip.employeeId,
    employeeNumber: slip.employee.employeeNumber,
    employeeName: nameOf(slip),
    shifNumber: slip.employee.shifNumber,
    grossPay: slip.grossPay,
    shif: slip.shifEmployee,
  }));
  const shifTotals = {
    grossPay: shifRows.reduce((s, r) => s + r.grossPay, 0n),
    shif: shifRows.reduce((s, r) => s + r.shif, 0n),
  };

  // --- Housing Levy (filed with KRA, so keyed by KRA PIN) ---
  const ahlRows: HousingLevyScheduleRow[] = slips.map((slip) => ({
    employeeId: slip.employeeId,
    employeeNumber: slip.employee.employeeNumber,
    employeeName: nameOf(slip),
    kraPin: slip.employee.kraPin,
    grossPay: slip.grossPay,
    employee: slip.ahlEmployee,
    employer: slip.ahlEmployer,
    total: slip.ahlEmployee + slip.ahlEmployer,
  }));
  const ahlTotals = {
    grossPay: ahlRows.reduce((s, r) => s + r.grossPay, 0n),
    employee: ahlRows.reduce((s, r) => s + r.employee, 0n),
    employer: ahlRows.reduce((s, r) => s + r.employer, 0n),
    total: ahlRows.reduce((s, r) => s + r.total, 0n),
  };

  const missingKraPin = missing(slips, "kraPin");

  // `payslipTotal` is summed straight off the payslip columns, independently of the
  // rows above, so a defect in building a row cannot hide behind its own total.
  const paye = {
    ...tieOut(positions.PAYE, payeTotals.paye, sumOf(slips, (s) => s.paye), missingKraPin),
    rows: payeRows,
    totals: payeTotals,
  };
  const nssf = {
    ...tieOut(
      positions.NSSF,
      nssfTotals.total,
      sumOf(slips, (s) => s.nssfEmployee + s.nssfEmployer),
      missing(slips, "nssfNumber"),
    ),
    rows: nssfRows,
    totals: nssfTotals,
  };
  const shif = {
    ...tieOut(positions.SHIF, shifTotals.shif, sumOf(slips, (s) => s.shifEmployee), missing(slips, "shifNumber")),
    rows: shifRows,
    totals: shifTotals,
  };
  const housingLevy = {
    ...tieOut(
      positions.HOUSING_LEVY,
      ahlTotals.total,
      sumOf(slips, (s) => s.ahlEmployee + s.ahlEmployer),
      missingKraPin,
    ),
    rows: ahlRows,
    totals: ahlTotals,
  };

  const schedules = [paye, nssf, shif, housingLevy];
  return {
    employer: await employerHeader(db, employerName),
    run: loaded.header,
    paye,
    nssf,
    shif,
    housingLevy,
    grandTotal: paye.total + nssf.total + shif.total + housingLevy.total,
    fileable: schedules.every((s) => s.reconciles && s.missingIdentifiers.length === 0),
  };
}

// ---------------------------------------------------------------------------
// 3. The muster roll
// ---------------------------------------------------------------------------

export interface MusterRow {
  payslipId: string;
  employeeId: string;
  employeeNumber: number;
  employeeName: string;
  grossPay: Cents;
  taxableGross: Cents;
  nssf: Cents;
  shif: Cents;
  housingLevy: Cents;
  paye: Cents;
  totalDeductions: Cents;
  netPay: Cents;
  employerNssf: Cents;
  employerHousingLevy: Cents;
  /** grossPay + the employer's contributions — what this employee cost the business. */
  employerCost: Cents;
}

export interface MusterTotals {
  grossPay: Cents;
  taxableGross: Cents;
  nssf: Cents;
  shif: Cents;
  housingLevy: Cents;
  paye: Cents;
  totalDeductions: Cents;
  netPay: Cents;
  employerNssf: Cents;
  employerHousingLevy: Cents;
  employerCost: Cents;
}

export interface MusterRoll {
  employer: EmployerHeader;
  run: RunHeader;
  rows: MusterRow[];
  totals: MusterTotals;
  employeeCount: number;
  /** What the run's accrual credited to 2120 Net Salaries Payable. NULL before posting. */
  glNetCredited: Cents | null;
  /**
   * Every row AND the totals satisfy `gross − deductions == net` and
   * `deductions == NSSF + SHIF + levy + PAYE`, and — once posted — the net total equals
   * what the accrual credited to 2120.
   */
  reconciles: boolean;
}

/**
 * Every payslip of a run, gross through deductions to net, with column totals — the
 * single table an employer signs off a payroll from.
 */
export async function buildMusterRoll(
  db: TenantPrismaClient,
  runId: string,
  employerName: string,
): Promise<MusterRoll | null> {
  const loaded = await loadRun(db, runId);
  if (loaded === null) {
    return null;
  }

  const rows: MusterRow[] = loaded.slips.map((slip) => ({
    payslipId: slip.id,
    employeeId: slip.employeeId,
    employeeNumber: slip.employee.employeeNumber,
    employeeName: nameOf(slip),
    grossPay: slip.grossPay,
    taxableGross: slip.taxableGross,
    nssf: slip.nssfEmployee,
    shif: slip.shifEmployee,
    housingLevy: slip.ahlEmployee,
    paye: slip.paye,
    totalDeductions: slip.totalEmployeeDeductions,
    netPay: slip.netPay,
    employerNssf: slip.nssfEmployer,
    employerHousingLevy: slip.ahlEmployer,
    employerCost: slip.grossPay + slip.nssfEmployer + slip.ahlEmployer,
  }));

  const total = (pick: (row: MusterRow) => bigint): Cents => rows.reduce((s, r) => s + pick(r), 0n);
  const totals: MusterTotals = {
    grossPay: total((r) => r.grossPay),
    taxableGross: total((r) => r.taxableGross),
    nssf: total((r) => r.nssf),
    shif: total((r) => r.shif),
    housingLevy: total((r) => r.housingLevy),
    paye: total((r) => r.paye),
    totalDeductions: total((r) => r.totalDeductions),
    netPay: total((r) => r.netPay),
    employerNssf: total((r) => r.employerNssf),
    employerHousingLevy: total((r) => r.employerHousingLevy),
    employerCost: total((r) => r.employerCost),
  };

  const identities = (r: Omit<MusterRow, "payslipId" | "employeeId" | "employeeNumber" | "employeeName"> | MusterTotals): boolean =>
    r.grossPay - r.totalDeductions === r.netPay &&
    r.totalDeductions === r.nssf + r.shif + r.housingLevy + r.paye;

  const glNetCredited = await runNetAccrued(db, { journalEntryId: loaded.journalEntryId });

  return {
    employer: await employerHeader(db, employerName),
    run: loaded.header,
    rows,
    totals,
    employeeCount: rows.length,
    glNetCredited,
    reconciles:
      rows.every(identities) &&
      identities(totals) &&
      (glNetCredited === null || glNetCredited === totals.netPay),
  };
}
