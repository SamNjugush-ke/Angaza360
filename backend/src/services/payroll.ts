// ===========================================================================
// PAYROLL — EMPLOYEE MASTER, RUN LIFECYCLE AND THE ACCRUAL (Module 8, Task 8.1).
//
// THIS IS THE ONLY MODULE PERMITTED TO WRITE `statutory_schedules`, `paye_bands`,
// `employees`, `employee_allowances`, `payroll_runs`, `payslips` OR
// `payslip_earnings`, and the only module that posts payroll GL.
//
// WHAT IT MUST NEVER DO:
//   * IT NEVER WRITES A STOCK TABLE AND NEVER POSTS TO ACCOUNT 1200. Paying people
//     is not a stock movement. `sum(Product.stockValue) = GL(1200)` is untouched by
//     every payroll operation.
//   * IT NEVER TOUCHES A REVENUE ACCOUNT. Payroll is a cost, not a sale.
//
// IT COMPUTES NOTHING ITSELF. Every figure comes from `src/lib/payroll-math.ts`,
// which is PURE — no database import at all. This file resolves the ruleset,
// snapshots the employees, persists what the engine returned and posts the ledger.
// That separation is why the worked examples can be checked as arithmetic.
//
// ---------------------------------------------------------------------------
// THE ACCRUAL, AND WHY IT IS THE ONLY THING THIS TASK POSTS
//
//   Dr 6020 Salaries & Wages                  Σ grossPay
//   Dr 6025 Employer Statutory Contributions  Σ (nssfEmployer + ahlEmployer)
//   Cr 2200 PAYE Payable                      Σ paye
//   Cr 2210 NSSF Payable                      Σ (nssfEmployee + nssfEmployer)
//   Cr 2220 SHA Payable                       Σ shifEmployee
//   Cr 2230 Housing Levy Payable              Σ (ahlEmployee + ahlEmployer)
//   Cr 2120 Net Salaries Payable              Σ netPay
//
// THE EMPLOYEE'S OWN DEDUCTIONS ARE NOT AN EXPENSE. They are already inside the
// gross in 6020 — the business's cost is what the employee EARNED, and PAYE, NSSF,
// SHIF and AHL are that same money being redirected to KRA, NSSF and SHA instead of
// to the employee's pocket. Only the EMPLOYER's matched contributions are an
// additional cost, which is why 6025 carries exactly those two and nothing else.
// Debiting the employee's deductions as well would double-count the whole payroll.
//
// WHY THE ENTRY BALANCES BY CONSTRUCTION: migration 0021 pins, per payslip,
// `totalEmployeeDeductions = nssf + shif + ahl + paye` and
// `netPay = grossPay − totalEmployeeDeductions`. Summing those gives
// `Σ gross = Σ nssfEmployee + Σ shif + Σ ahlEmployee + Σ paye + Σ net`, and the two
// employer legs appear once as a debit and once inside a credit. So the seven legs
// cannot fail to balance unless a payslip itself is wrong — which the database has
// already refused. The posting code ASSERTS it anyway and fails loudly, because an
// assertion that never fires costs nothing and the one that does would be telling us
// something we need to hear.
//
// SETTLEMENT LIVES IN `src/services/payroll-settlement.ts` (Task 8.2): paying 2120
// and remitting 2200/2210/2220/2230 to cash. Nothing in THIS file moves cash. The one
// settlement fact this file still owns is the run's POSTED -> PAID flip, because this
// remains the ONLY writer of `payroll_runs` — see
// `markPayrollRunPaidWithinTransaction`.
// ===========================================================================

import type { PrismaClient as TenantPrismaClient } from "../generated/tenant/client";
import type {
  EmployeePaymentMethod,
  EmployeeStatus,
  EmploymentType,
  PayrollRunStatus,
} from "../generated/tenant/enums";
import { assertValidSchemaName, tenantSchemaFor } from "../db/tenant";
import type { Cents } from "../lib/money";
import {
  computePayroll,
  totalPayslips,
  PayrollInputError,
  PayrollRulesetError,
  type PayrollRuleset,
  type EarningInput,
} from "../lib/payroll-math";
import {
  postJournalEntryWithinTransaction,
  type JournalLineInput,
  type LedgerTx,
} from "./ledger";

/** Bad input (unknown employee, no covering schedule, a negative amount). Route -> 400. */
export class PayrollValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayrollValidationError";
  }
}

/** The run's current state forbids the operation (posting a DRAFT). Route -> 409. */
export class PayrollStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayrollStateError";
  }
}

// The seven accounts a payroll accrual may touch, and no others.
const ACCT_SALARIES = "6020";
const ACCT_EMPLOYER_STATUTORY = "6025";
const ACCT_PAYE = "2200";
const ACCT_NSSF = "2210";
const ACCT_SHA = "2220";
const ACCT_HOUSING_LEVY = "2230";
const ACCT_NET_SALARIES = "2120";

function resolveSchema(db: TenantPrismaClient): string {
  const schema = tenantSchemaFor(db);
  assertValidSchemaName(schema);
  return schema;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface EmployeeAllowanceRow {
  id: string;
  name: string;
  amount: Cents;
  taxable: boolean;
}

export interface EmployeeRow {
  id: string;
  employeeNumber: number;
  firstName: string;
  lastName: string;
  nationalId: string | null;
  kraPin: string | null;
  nssfNumber: string | null;
  shifNumber: string | null;
  employmentType: EmploymentType;
  status: EmployeeStatus;
  hireDate: Date;
  terminationDate: Date | null;
  basicSalary: Cents;
  paymentMethod: EmployeePaymentMethod;
  bankName: string | null;
  bankAccount: string | null;
  createdAt: Date;
  updatedAt: Date;
  allowances: EmployeeAllowanceRow[];
  /** basicSalary + every allowance. Derived, so a reader never has to add it up. */
  grossMonthly: Cents;
}

export interface PayeBandRow {
  ordinal: number;
  lowerBound: Cents;
  upperBound: Cents | null;
  ratePercent: string;
}

export interface StatutoryScheduleRow {
  id: string;
  label: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  source: string;
  verifiedOn: Date;
  notes: string | null;
  personalRelief: Cents;
  nssfRatePercent: string;
  nssfLowerLimit: Cents;
  nssfUpperLimit: Cents;
  shifRatePercent: string;
  shifMinimum: Cents;
  ahlRatePercent: string;
  vatStandardRate: string;
  vatRateSource: string;
  vatRateVerifiedOn: Date;
  totRatePercent: string;
  totRateSource: string;
  totRateVerifiedOn: Date;
  /** Who superseded the previous version (Task 3B.3); null = the system seed. */
  createdById: string | null;
  createdAt: Date;
  bands: PayeBandRow[];
}

export interface PayslipEarningRow {
  name: string;
  amount: Cents;
  taxable: boolean;
}

export interface PayslipRow {
  id: string;
  payrollRunId: string;
  employeeId: string;
  employeeNumber: number;
  employeeName: string;
  grossPay: Cents;
  taxableGross: Cents;
  nssfEmployee: Cents;
  nssfEmployer: Cents;
  nssfTier1: Cents;
  nssfTier2: Cents;
  shifEmployee: Cents;
  ahlEmployee: Cents;
  ahlEmployer: Cents;
  taxablePay: Cents;
  payeBeforeRelief: Cents;
  personalReliefApplied: Cents;
  paye: Cents;
  totalEmployeeDeductions: Cents;
  netPay: Cents;
  createdAt: Date;
  earnings: PayslipEarningRow[];
}

export interface PayrollRunTotalsRow {
  grossPay: Cents;
  employerContributions: Cents;
  paye: Cents;
  nssfTotal: Cents;
  shifTotal: Cents;
  housingLevyTotal: Cents;
  netPay: Cents;
  employeeCount: number;
}

export interface PayrollRunRow {
  id: string;
  runNumber: number;
  periodYear: number;
  periodMonth: number;
  status: PayrollRunStatus;
  payDate: Date;
  statutoryScheduleId: string;
  statutoryScheduleLabel: string;
  journalEntryId: string | null;
  createdById: string;
  approvedById: string | null;
  postedAt: Date | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  totals: PayrollRunTotalsRow;
}

export interface PayrollRunDetail extends PayrollRunRow {
  payslips: PayslipRow[];
}

const EMPLOYEE_INCLUDE = { allowances: { orderBy: { name: "asc" } } } as const;

const SCHEDULE_INCLUDE = { bands: { orderBy: { ordinal: "asc" } } } as const;

const PAYSLIP_INCLUDE = {
  employee: { select: { employeeNumber: true, firstName: true, lastName: true } },
  earnings: { orderBy: { name: "asc" } },
} as const;

const RUN_INCLUDE = {
  statutorySchedule: { select: { label: true } },
  payslips: { include: PAYSLIP_INCLUDE, orderBy: { createdAt: "asc" } },
} as const;

interface RawAllowance {
  id: string;
  name: string;
  amount: bigint;
  taxable: boolean;
}

interface RawEmployee {
  id: string;
  employeeNumber: number;
  firstName: string;
  lastName: string;
  nationalId: string | null;
  kraPin: string | null;
  nssfNumber: string | null;
  shifNumber: string | null;
  employmentType: EmploymentType;
  status: EmployeeStatus;
  hireDate: Date;
  terminationDate: Date | null;
  basicSalary: bigint;
  paymentMethod: EmployeePaymentMethod;
  bankName: string | null;
  bankAccount: string | null;
  createdAt: Date;
  updatedAt: Date;
  allowances: RawAllowance[];
}

function toEmployeeRow(employee: RawEmployee): EmployeeRow {
  let gross = employee.basicSalary;
  for (const allowance of employee.allowances) {
    gross += allowance.amount;
  }
  return {
    id: employee.id,
    employeeNumber: employee.employeeNumber,
    firstName: employee.firstName,
    lastName: employee.lastName,
    nationalId: employee.nationalId,
    kraPin: employee.kraPin,
    nssfNumber: employee.nssfNumber,
    shifNumber: employee.shifNumber,
    employmentType: employee.employmentType,
    status: employee.status,
    hireDate: employee.hireDate,
    terminationDate: employee.terminationDate,
    basicSalary: employee.basicSalary,
    paymentMethod: employee.paymentMethod,
    bankName: employee.bankName,
    bankAccount: employee.bankAccount,
    createdAt: employee.createdAt,
    updatedAt: employee.updatedAt,
    allowances: employee.allowances.map((a) => ({
      id: a.id,
      name: a.name,
      amount: a.amount,
      taxable: a.taxable,
    })),
    grossMonthly: gross,
  };
}

interface RawBand {
  ordinal: number;
  lowerBound: bigint;
  upperBound: bigint | null;
  ratePercent: { toString(): string };
}

interface RawSchedule {
  id: string;
  label: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  source: string;
  verifiedOn: Date;
  notes: string | null;
  personalRelief: bigint;
  nssfRatePercent: { toString(): string };
  nssfLowerLimit: bigint;
  nssfUpperLimit: bigint;
  shifRatePercent: { toString(): string };
  shifMinimum: bigint;
  ahlRatePercent: { toString(): string };
  vatStandardRate: { toString(): string };
  vatRateSource: string;
  vatRateVerifiedOn: Date;
  totRatePercent: { toString(): string };
  totRateSource: string;
  totRateVerifiedOn: Date;
  createdById: string | null;
  createdAt: Date;
  bands: RawBand[];
}

function toScheduleRow(schedule: RawSchedule): StatutoryScheduleRow {
  return {
    id: schedule.id,
    label: schedule.label,
    effectiveFrom: schedule.effectiveFrom,
    effectiveTo: schedule.effectiveTo,
    source: schedule.source,
    verifiedOn: schedule.verifiedOn,
    notes: schedule.notes,
    personalRelief: schedule.personalRelief,
    nssfRatePercent: schedule.nssfRatePercent.toString(),
    nssfLowerLimit: schedule.nssfLowerLimit,
    nssfUpperLimit: schedule.nssfUpperLimit,
    shifRatePercent: schedule.shifRatePercent.toString(),
    shifMinimum: schedule.shifMinimum,
    ahlRatePercent: schedule.ahlRatePercent.toString(),
    vatStandardRate: schedule.vatStandardRate.toString(),
    vatRateSource: schedule.vatRateSource,
    vatRateVerifiedOn: schedule.vatRateVerifiedOn,
    totRatePercent: schedule.totRatePercent.toString(),
    totRateSource: schedule.totRateSource,
    totRateVerifiedOn: schedule.totRateVerifiedOn,
    createdById: schedule.createdById,
    createdAt: schedule.createdAt,
    bands: schedule.bands.map((b) => ({
      ordinal: b.ordinal,
      lowerBound: b.lowerBound,
      upperBound: b.upperBound,
      ratePercent: b.ratePercent.toString(),
    })),
  };
}

/** The engine's view of a schedule. The ONLY place a row becomes a ruleset. */
function toRuleset(schedule: StatutoryScheduleRow): PayrollRuleset {
  return {
    label: schedule.label,
    personalRelief: schedule.personalRelief,
    nssfRatePercent: schedule.nssfRatePercent,
    nssfLowerLimit: schedule.nssfLowerLimit,
    nssfUpperLimit: schedule.nssfUpperLimit,
    shifRatePercent: schedule.shifRatePercent,
    shifMinimum: schedule.shifMinimum,
    ahlRatePercent: schedule.ahlRatePercent,
    bands: schedule.bands,
  };
}

interface RawPayslip {
  id: string;
  payrollRunId: string;
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
  createdAt: Date;
  employee: { employeeNumber: number; firstName: string; lastName: string };
  earnings: Array<{ name: string; amount: bigint; taxable: boolean }>;
}

function toPayslipRow(slip: RawPayslip): PayslipRow {
  return {
    id: slip.id,
    payrollRunId: slip.payrollRunId,
    employeeId: slip.employeeId,
    employeeNumber: slip.employee.employeeNumber,
    employeeName: `${slip.employee.firstName} ${slip.employee.lastName}`,
    grossPay: slip.grossPay,
    taxableGross: slip.taxableGross,
    nssfEmployee: slip.nssfEmployee,
    nssfEmployer: slip.nssfEmployer,
    nssfTier1: slip.nssfTier1,
    nssfTier2: slip.nssfTier2,
    shifEmployee: slip.shifEmployee,
    ahlEmployee: slip.ahlEmployee,
    ahlEmployer: slip.ahlEmployer,
    taxablePay: slip.taxablePay,
    payeBeforeRelief: slip.payeBeforeRelief,
    personalReliefApplied: slip.personalReliefApplied,
    paye: slip.paye,
    totalEmployeeDeductions: slip.totalEmployeeDeductions,
    netPay: slip.netPay,
    createdAt: slip.createdAt,
    earnings: slip.earnings.map((e) => ({
      name: e.name,
      amount: e.amount,
      taxable: e.taxable,
    })),
  };
}

interface RawRun {
  id: string;
  runNumber: number;
  periodYear: number;
  periodMonth: number;
  status: PayrollRunStatus;
  payDate: Date;
  statutoryScheduleId: string;
  journalEntryId: string | null;
  createdById: string;
  approvedById: string | null;
  postedAt: Date | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  statutorySchedule: { label: string };
  payslips: RawPayslip[];
}

/**
 * The run-level sums, derived from the payslips rather than stored.
 *
 * NOT a column, deliberately: a stored total could disagree with the payslips it
 * claims to total, and the ledger legs are built from these same figures — so one
 * derivation keeps the report, the entry and the payslips necessarily consistent.
 */
function runTotals(payslips: ReadonlyArray<RawPayslip>): PayrollRunTotalsRow {
  const t = totalPayslips(payslips);
  return {
    grossPay: t.grossPay,
    employerContributions: t.nssfEmployer + t.ahlEmployer,
    paye: t.paye,
    nssfTotal: t.nssfEmployee + t.nssfEmployer,
    shifTotal: t.shifEmployee,
    housingLevyTotal: t.ahlEmployee + t.ahlEmployer,
    netPay: t.netPay,
    employeeCount: payslips.length,
  };
}

function toRunRow(run: RawRun): PayrollRunRow {
  return {
    id: run.id,
    runNumber: run.runNumber,
    periodYear: run.periodYear,
    periodMonth: run.periodMonth,
    status: run.status,
    payDate: run.payDate,
    statutoryScheduleId: run.statutoryScheduleId,
    statutoryScheduleLabel: run.statutorySchedule.label,
    journalEntryId: run.journalEntryId,
    createdById: run.createdById,
    approvedById: run.approvedById,
    postedAt: run.postedAt,
    notes: run.notes,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    totals: runTotals(run.payslips),
  };
}

function toRunDetail(run: RawRun): PayrollRunDetail {
  return { ...toRunRow(run), payslips: run.payslips.map(toPayslipRow) };
}

// ---------------------------------------------------------------------------
// Numbering and locking
// ---------------------------------------------------------------------------

async function nextNumber(
  tx: LedgerTx,
  schema: string,
  sequence: "employee_number_seq" | "payroll_run_number_seq",
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

/**
 * Load a run under a ROW LOCK.
 *
 * The lock is what makes the lifecycle transitions safe: two concurrent approvals or
 * two concurrent posts serialise on the run row, so the second sees the first's
 * status and is refused by the state machine rather than posting the accrual twice.
 */
async function lockRun(tx: LedgerTx, schema: string, id: string): Promise<RawRun> {
  assertValidSchemaName(schema);
  const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT "id" FROM "${schema}".payroll_runs WHERE "id" = $1 FOR UPDATE`,
    id,
  );
  if (locked[0] === undefined) {
    throw new PayrollValidationError(`Unknown payroll run ${id}.`);
  }
  const run = await tx.payrollRun.findUnique({ where: { id }, include: RUN_INCLUDE });
  if (run === null) {
    throw new PayrollValidationError(`Unknown payroll run ${id}.`);
  }
  return run;
}

// ---------------------------------------------------------------------------
// 1. Statutory schedules — READ ONLY through this service
// ---------------------------------------------------------------------------

/**
 * Resolve the ONE schedule governing a period, or refuse.
 *
 * The period is represented by its FIRST DAY: a monthly payroll is governed by the
 * ruleset in force at the start of the month it pays for.
 *
 * **IT REFUSES RATHER THAN FALLING BACK.** No covering schedule means no run — it
 * never quietly uses "the latest", because computing February on March's bands is
 * precisely the error the effective-dated table exists to prevent, and it would be
 * invisible in the output. More than one covering schedule is impossible at the
 * database (migration 0021's GiST exclusion constraint), and this check is the
 * ergonomic half of that pair: if it ever fires, something is wrong that needs
 * looking at rather than resolving by preference.
 */
export async function resolveScheduleForPeriod(
  db: TenantPrismaClient | LedgerTx,
  periodYear: number,
  periodMonth: number,
): Promise<StatutoryScheduleRow> {
  const periodStart = new Date(Date.UTC(periodYear, periodMonth - 1, 1));
  const covering = await db.statutorySchedule.findMany({
    where: {
      effectiveFrom: { lte: periodStart },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: periodStart } }],
    },
    include: SCHEDULE_INCLUDE,
  });

  const period = `${periodYear.toString()}-${periodMonth.toString().padStart(2, "0")}`;
  if (covering.length === 0) {
    throw new PayrollValidationError(
      `No statutory schedule covers ${period}. Payroll cannot be computed without the rates that were in force: seed the schedule for that period rather than letting the run fall back to a later ruleset.`,
    );
  }
  if (covering.length > 1) {
    throw new PayrollValidationError(
      `${covering.length.toString()} statutory schedules cover ${period} (${covering.map((s) => s.label).join(", ")}). Exactly one must, and the database constraint that guarantees it appears to have been bypassed — investigate rather than picking one.`,
    );
  }
  const only = covering[0];
  if (only === undefined) {
    throw new PayrollValidationError(`No statutory schedule covers ${period}.`);
  }
  if (only.bands.length === 0) {
    throw new PayrollValidationError(
      `Statutory schedule ${only.label} has no PAYE bands, so there is no ladder to compute tax on.`,
    );
  }
  return toScheduleRow(only);
}

/**
 * The version IN FORCE on a business date (Task 3B.3) — the one whose half-open window
 * [effectiveFrom, effectiveTo) contains it — or null if none does. Read-only.
 */
export async function getStatutoryScheduleInForce(
  db: TenantPrismaClient,
  onDate: Date,
): Promise<StatutoryScheduleRow | null> {
  const covering = await db.statutorySchedule.findMany({
    where: {
      effectiveFrom: { lte: onDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: onDate } }],
    },
    include: SCHEDULE_INCLUDE,
  });
  const only = covering.length === 1 ? covering[0] : undefined;
  return only === undefined ? null : toScheduleRow(only);
}

export async function getStatutorySchedule(
  db: TenantPrismaClient,
  id: string,
): Promise<StatutoryScheduleRow | null> {
  const schedule = await db.statutorySchedule.findUnique({ where: { id }, include: SCHEDULE_INCLUDE });
  return schedule === null ? null : toScheduleRow(schedule);
}

export async function listStatutorySchedules(
  db: TenantPrismaClient,
): Promise<StatutoryScheduleRow[]> {
  const schedules = await db.statutorySchedule.findMany({
    include: SCHEDULE_INCLUDE,
    orderBy: { effectiveFrom: "desc" },
  });
  return schedules.map(toScheduleRow);
}

// ---------------------------------------------------------------------------
// 2. Employee master
// ---------------------------------------------------------------------------

export interface AllowanceInput {
  name: string;
  amount: Cents;
  taxable?: boolean;
}

export interface CreateEmployeeInput {
  firstName: string;
  lastName: string;
  nationalId?: string;
  kraPin?: string;
  nssfNumber?: string;
  shifNumber?: string;
  employmentType?: EmploymentType;
  hireDate: Date;
  basicSalary: Cents;
  paymentMethod?: EmployeePaymentMethod;
  bankName?: string;
  bankAccount?: string;
  allowances?: AllowanceInput[];
}

function validateAllowances(allowances: ReadonlyArray<AllowanceInput>): void {
  const seen = new Set<string>();
  for (const allowance of allowances) {
    const name = allowance.name.trim();
    if (name === "") {
      throw new PayrollValidationError("An allowance needs a name.");
    }
    if (allowance.amount < 0n) {
      throw new PayrollValidationError(`Allowance "${name}" must not be negative.`);
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      throw new PayrollValidationError(
        `Allowance "${name}" appears twice. Give one line per allowance so a payslip reads unambiguously.`,
      );
    }
    seen.add(key);
  }
}

export async function createEmployee(
  db: TenantPrismaClient,
  input: CreateEmployeeInput,
): Promise<EmployeeRow> {
  const schema = resolveSchema(db);
  if (input.basicSalary < 0n) {
    throw new PayrollValidationError("basicSalary must not be negative.");
  }
  const allowances = input.allowances ?? [];
  validateAllowances(allowances);

  return db.$transaction(async (tx) => {
    const employeeNumber = await nextNumber(tx, schema, "employee_number_seq");
    const created = await tx.employee.create({
      data: {
        employeeNumber,
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        ...(input.nationalId !== undefined ? { nationalId: input.nationalId } : {}),
        ...(input.kraPin !== undefined ? { kraPin: input.kraPin } : {}),
        ...(input.nssfNumber !== undefined ? { nssfNumber: input.nssfNumber } : {}),
        ...(input.shifNumber !== undefined ? { shifNumber: input.shifNumber } : {}),
        ...(input.employmentType !== undefined ? { employmentType: input.employmentType } : {}),
        hireDate: input.hireDate,
        basicSalary: input.basicSalary,
        ...(input.paymentMethod !== undefined ? { paymentMethod: input.paymentMethod } : {}),
        ...(input.bankName !== undefined ? { bankName: input.bankName } : {}),
        ...(input.bankAccount !== undefined ? { bankAccount: input.bankAccount } : {}),
        allowances: {
          create: allowances.map((a) => ({
            name: a.name.trim(),
            amount: a.amount,
            taxable: a.taxable ?? true,
          })),
        },
      },
      include: EMPLOYEE_INCLUDE,
    });
    return toEmployeeRow(created);
  });
}

export interface UpdateEmployeeInput {
  firstName?: string;
  lastName?: string;
  nationalId?: string | null;
  kraPin?: string | null;
  nssfNumber?: string | null;
  shifNumber?: string | null;
  employmentType?: EmploymentType;
  basicSalary?: Cents;
  paymentMethod?: EmployeePaymentMethod;
  bankName?: string | null;
  bankAccount?: string | null;
  /** Supplied: the allowance set is REPLACED wholesale. */
  allowances?: AllowanceInput[];
}

/**
 * Update an employee's standing terms.
 *
 * **IT CHANGES NO PAYSLIP, EVER.** A run SNAPSHOTS the terms into
 * `payslip_earnings`, so a salary revision affects the NEXT run, and a DRAFT run
 * only picks it up when it is explicitly recomputed. A posted payslip is frozen by
 * migration 0021's guard regardless. That is what makes "what was this employee paid
 * in March" answerable in December.
 *
 * The allowance set is REPLACED rather than merged when supplied, exactly as a DRAFT
 * purchase order's or supplier bill's lines are: a partial merge would need a
 * per-line identity the client does not have, and guessing one silently drops a
 * change.
 */
export async function updateEmployee(
  db: TenantPrismaClient,
  id: string,
  input: UpdateEmployeeInput,
): Promise<EmployeeRow> {
  if (input.basicSalary !== undefined && input.basicSalary < 0n) {
    throw new PayrollValidationError("basicSalary must not be negative.");
  }
  if (input.allowances !== undefined) {
    validateAllowances(input.allowances);
  }

  return db.$transaction(async (tx) => {
    const existing = await tx.employee.findUnique({ where: { id }, select: { id: true } });
    if (existing === null) {
      throw new PayrollValidationError(`Unknown employee ${id}.`);
    }
    if (input.allowances !== undefined) {
      await tx.employeeAllowance.deleteMany({ where: { employeeId: id } });
      for (const allowance of input.allowances) {
        await tx.employeeAllowance.create({
          data: {
            employeeId: id,
            name: allowance.name.trim(),
            amount: allowance.amount,
            taxable: allowance.taxable ?? true,
          },
        });
      }
    }
    const updated = await tx.employee.update({
      where: { id },
      data: {
        ...(input.firstName !== undefined ? { firstName: input.firstName.trim() } : {}),
        ...(input.lastName !== undefined ? { lastName: input.lastName.trim() } : {}),
        ...(input.nationalId !== undefined ? { nationalId: input.nationalId } : {}),
        ...(input.kraPin !== undefined ? { kraPin: input.kraPin } : {}),
        ...(input.nssfNumber !== undefined ? { nssfNumber: input.nssfNumber } : {}),
        ...(input.shifNumber !== undefined ? { shifNumber: input.shifNumber } : {}),
        ...(input.employmentType !== undefined ? { employmentType: input.employmentType } : {}),
        ...(input.basicSalary !== undefined ? { basicSalary: input.basicSalary } : {}),
        ...(input.paymentMethod !== undefined ? { paymentMethod: input.paymentMethod } : {}),
        ...(input.bankName !== undefined ? { bankName: input.bankName } : {}),
        ...(input.bankAccount !== undefined ? { bankAccount: input.bankAccount } : {}),
      },
      include: EMPLOYEE_INCLUDE,
    });
    return toEmployeeRow(updated);
  });
}

/**
 * Take an employee off the payroll.
 *
 * SUSPENDED and TERMINATED both drop out of NEW runs; neither deletes anything, and
 * neither touches a payslip already computed. An employee with payroll history can
 * never be deleted — the history is what a P9 is built from — which is why this is a
 * status change rather than a delete.
 *
 * A termination REQUIRES its date (CHECK-enforced): "they have left" without a
 * leaving date cannot be filed.
 */
export async function setEmployeeStatus(
  db: TenantPrismaClient,
  id: string,
  status: EmployeeStatus,
  terminationDate?: Date,
): Promise<EmployeeRow> {
  const employee = await db.employee.findUnique({
    where: { id },
    select: { id: true, status: true, hireDate: true, firstName: true, lastName: true },
  });
  if (employee === null) {
    throw new PayrollValidationError(`Unknown employee ${id}.`);
  }
  if (status === "TERMINATED") {
    if (terminationDate === undefined) {
      throw new PayrollValidationError(
        "A termination needs its date: an employee who has left without a leaving date cannot be filed for.",
      );
    }
    if (terminationDate < employee.hireDate) {
      throw new PayrollValidationError("terminationDate cannot be before the hire date.");
    }
  }
  const updated = await db.employee.update({
    where: { id },
    data: {
      status,
      terminationDate: status === "TERMINATED" ? (terminationDate ?? null) : null,
    },
    include: EMPLOYEE_INCLUDE,
  });
  return toEmployeeRow(updated);
}

export interface ListEmployeeFilters {
  status?: EmployeeStatus;
}

export async function listEmployees(
  db: TenantPrismaClient,
  filters: ListEmployeeFilters = {},
): Promise<EmployeeRow[]> {
  const employees = await db.employee.findMany({
    where: filters.status !== undefined ? { status: filters.status } : {},
    include: EMPLOYEE_INCLUDE,
    orderBy: { employeeNumber: "asc" },
  });
  return employees.map(toEmployeeRow);
}

export async function getEmployee(
  db: TenantPrismaClient,
  id: string,
): Promise<EmployeeRow | null> {
  const employee = await db.employee.findUnique({ where: { id }, include: EMPLOYEE_INCLUDE });
  return employee === null ? null : toEmployeeRow(employee);
}

// ---------------------------------------------------------------------------
// 3. The run lifecycle
// ---------------------------------------------------------------------------

/**
 * Compute every ACTIVE employee's payslip and write it, replacing whatever the run
 * held before.
 *
 * ONLY ACTIVE EMPLOYEES. A SUSPENDED or TERMINATED employee is excluded from a NEW
 * run, which is what `status` is for — their existing payslips are untouched, because
 * they describe months they genuinely worked.
 *
 * Shared by `createRun` and `recomputeRun` so there is exactly ONE definition of
 * "what this run's payslips are", and a recompute cannot drift from a create.
 */
async function snapshotPayslips(
  tx: LedgerTx,
  runId: string,
  schedule: StatutoryScheduleRow,
): Promise<number> {
  const ruleset = toRuleset(schedule);
  const employees = await tx.employee.findMany({
    where: { status: "ACTIVE" },
    include: EMPLOYEE_INCLUDE,
    orderBy: { employeeNumber: "asc" },
  });

  // Replace wholesale. The payslip guard permits this only while the run is a DRAFT,
  // which is exactly the window a recompute is allowed in.
  await tx.payslip.deleteMany({ where: { payrollRunId: runId } });

  for (const employee of employees) {
    const allowances: EarningInput[] = employee.allowances.map((a) => ({
      name: a.name,
      amount: a.amount,
      taxable: a.taxable,
    }));
    const computed = computePayroll(
      { basicSalary: employee.basicSalary, allowances },
      ruleset,
    );
    await tx.payslip.create({
      data: {
        payrollRunId: runId,
        employeeId: employee.id,
        grossPay: computed.grossPay,
        taxableGross: computed.taxableGross,
        nssfEmployee: computed.nssfEmployee,
        nssfEmployer: computed.nssfEmployer,
        nssfTier1: computed.nssfTier1,
        nssfTier2: computed.nssfTier2,
        shifEmployee: computed.shifEmployee,
        ahlEmployee: computed.ahlEmployee,
        ahlEmployer: computed.ahlEmployer,
        taxablePay: computed.taxablePay,
        payeBeforeRelief: computed.payeBeforeRelief,
        personalReliefApplied: computed.personalReliefApplied,
        paye: computed.paye,
        totalEmployeeDeductions: computed.totalEmployeeDeductions,
        netPay: computed.netPay,
        earnings: {
          create: computed.earnings.map((e) => ({
            name: e.name,
            amount: e.amount,
            taxable: e.taxable,
          })),
        },
      },
    });
  }
  return employees.length;
}

export interface CreatePayrollRunInput {
  periodYear: number;
  periodMonth: number;
  payDate: Date;
  notes?: string;
  createdById: string;
}

/**
 * CREATE A DRAFT RUN and compute its payslips. **Posts NOTHING to the ledger.**
 *
 * A DRAFT is the reviewable state: the payroll officer can recompute it as often as
 * they like while a missing allowance is chased, and the books never hear about it.
 * That is why posting is a separate operation and why DRAFT is a state rather than a
 * flag.
 */
export async function createPayrollRun(
  db: TenantPrismaClient,
  input: CreatePayrollRunInput,
): Promise<PayrollRunDetail> {
  const schema = resolveSchema(db);
  if (input.periodMonth < 1 || input.periodMonth > 12) {
    throw new PayrollValidationError("periodMonth must be between 1 and 12.");
  }

  return db.$transaction(async (tx) => {
    const existing = await tx.payrollRun.findFirst({
      where: {
        periodYear: input.periodYear,
        periodMonth: input.periodMonth,
        status: { not: "CANCELLED" },
      },
      select: { runNumber: true, status: true },
    });
    if (existing !== null) {
      throw new PayrollStateError(
        `Payroll run ${existing.runNumber.toString()} already covers ${input.periodYear.toString()}-${input.periodMonth.toString().padStart(2, "0")} (currently ${existing.status}). One payroll per month: a second live run would double the accrual and double what every statutory head is owed.`,
      );
    }

    const schedule = await resolveScheduleForPeriod(tx, input.periodYear, input.periodMonth);
    const runNumber = await nextNumber(tx, schema, "payroll_run_number_seq");

    const run = await tx.payrollRun.create({
      data: {
        runNumber,
        periodYear: input.periodYear,
        periodMonth: input.periodMonth,
        payDate: input.payDate,
        statutoryScheduleId: schedule.id,
        createdById: input.createdById,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
    });

    const count = await snapshotPayslips(tx, run.id, schedule);
    if (count === 0) {
      throw new PayrollValidationError(
        "There are no ACTIVE employees to pay, so there is nothing to compute. Add employees before creating a payroll run.",
      );
    }

    const loaded = await tx.payrollRun.findUniqueOrThrow({
      where: { id: run.id },
      include: RUN_INCLUDE,
    });
    return toRunDetail(loaded);
  });
}

/**
 * Recompute a DRAFT run against the CURRENT employee master.
 *
 * It re-resolves the schedule too, so a correction to the ruleset for an unposted
 * period is picked up — the schedule guard permits editing a schedule no run has
 * posted against.
 */
export async function recomputePayrollRun(
  db: TenantPrismaClient,
  id: string,
): Promise<PayrollRunDetail> {
  const schema = resolveSchema(db);

  return db.$transaction(async (tx) => {
    const run = await lockRun(tx, schema, id);
    if (run.status !== "DRAFT") {
      throw new PayrollStateError(
        `Payroll run ${run.runNumber.toString()} is ${run.status} and can no longer be recomputed: its payslips ARE its accrual entry. Only a DRAFT may be recomputed.`,
      );
    }
    const schedule = await resolveScheduleForPeriod(tx, run.periodYear, run.periodMonth);
    if (schedule.id !== run.statutoryScheduleId) {
      await tx.payrollRun.update({
        where: { id: run.id },
        data: { statutoryScheduleId: schedule.id },
      });
    }
    const count = await snapshotPayslips(tx, run.id, schedule);
    if (count === 0) {
      throw new PayrollValidationError(
        "There are no ACTIVE employees to pay, so the run would be empty.",
      );
    }
    const loaded = await tx.payrollRun.findUniqueOrThrow({
      where: { id: run.id },
      include: RUN_INCLUDE,
    });
    return toRunDetail(loaded);
  });
}

export async function approvePayrollRun(
  db: TenantPrismaClient,
  id: string,
  approvedById: string,
): Promise<PayrollRunDetail> {
  const schema = resolveSchema(db);

  return db.$transaction(async (tx) => {
    const run = await lockRun(tx, schema, id);
    if (run.status !== "DRAFT") {
      throw new PayrollStateError(
        `Payroll run ${run.runNumber.toString()} is already ${run.status} and cannot be approved again.`,
      );
    }
    if (run.payslips.length === 0) {
      throw new PayrollValidationError(
        `Payroll run ${run.runNumber.toString()} has no payslips, so there is nothing to approve.`,
      );
    }
    await tx.payrollRun.update({
      where: { id: run.id },
      data: { status: "APPROVED", approvedById },
    });
    const loaded = await tx.payrollRun.findUniqueOrThrow({
      where: { id: run.id },
      include: RUN_INCLUDE,
    });
    return toRunDetail(loaded);
  });
}

/**
 * POST THE ACCRUAL — the one operation in this task with a financial effect.
 *
 * See the seven legs in this file's header. In ONE transaction it posts the entry,
 * records its id on the run and moves the run to POSTED. Either all of it commits or
 * none does: a run marked posted without its entry would leave the liabilities
 * understated, and an entry without the run would leave seven balances with nothing
 * explaining them.
 *
 * **IT POSTS TO EXACTLY SEVEN ACCOUNTS AND TOUCHES NO OTHER.** Not 1200, not any
 * revenue account, and no stock table — payroll is neither a stock movement nor a
 * sale.
 */
export async function postPayrollRun(
  db: TenantPrismaClient,
  id: string,
  postedById: string,
): Promise<PayrollRunDetail> {
  const schema = resolveSchema(db);

  return db.$transaction(async (tx) => {
    const run = await lockRun(tx, schema, id);
    if (run.status === "DRAFT") {
      throw new PayrollStateError(
        `Payroll run ${run.runNumber.toString()} is still a DRAFT: approve it before posting. Approval is a separate step because posting is what commits the business to the figures.`,
      );
    }
    if (run.status !== "APPROVED") {
      throw new PayrollStateError(
        `Payroll run ${run.runNumber.toString()} is ${run.status} and cannot be posted.`,
      );
    }
    if (run.payslips.length === 0) {
      throw new PayrollValidationError(
        `Payroll run ${run.runNumber.toString()} has no payslips, so there is nothing to accrue.`,
      );
    }

    const totals = totalPayslips(run.payslips);
    const employerContributions = totals.nssfEmployer + totals.ahlEmployer;

    // The seven legs, in chart order. A ZERO leg is OMITTED rather than posted as a
    // zero line — a payroll where nobody earned enough to pay tax should carry no
    // PAYE line at all, not a line asserting zero.
    const candidates: Array<{ accountCode: string; debit?: Cents; credit?: Cents; memo: string }> = [
      { accountCode: ACCT_SALARIES, debit: totals.grossPay, memo: "Gross pay for the period" },
      {
        accountCode: ACCT_EMPLOYER_STATUTORY,
        debit: employerContributions,
        memo: "Employer NSSF and housing levy",
      },
      { accountCode: ACCT_PAYE, credit: totals.paye, memo: "PAYE withheld" },
      {
        accountCode: ACCT_NSSF,
        credit: totals.nssfEmployee + totals.nssfEmployer,
        memo: "NSSF employee + employer",
      },
      { accountCode: ACCT_SHA, credit: totals.shifEmployee, memo: "SHIF employee" },
      {
        accountCode: ACCT_HOUSING_LEVY,
        credit: totals.ahlEmployee + totals.ahlEmployer,
        memo: "Housing levy employee + employer",
      },
      { accountCode: ACCT_NET_SALARIES, credit: totals.netPay, memo: "Net pay owed to employees" },
    ];
    const lines: JournalLineInput[] = candidates.filter(
      (line) => (line.debit ?? 0n) > 0n || (line.credit ?? 0n) > 0n,
    );

    // ASSERT THE ENTRY BALANCES BEFORE POSTING IT, AND FAIL LOUDLY IF IT DOES NOT.
    //
    // It balances BY CONSTRUCTION from the per-payslip CHECKs in migration 0021 (see
    // this file's header), so this should never fire — which is exactly why it is
    // worth having: if it ever does, a payslip identity has been bypassed and the
    // right response is to stop, not to plug the difference into an account.
    const debits = lines.reduce((sum, line) => sum + (line.debit ?? 0n), 0n);
    const credits = lines.reduce((sum, line) => sum + (line.credit ?? 0n), 0n);
    if (debits !== credits) {
      throw new Error(
        `Payroll run ${run.runNumber.toString()} would post an unbalanced accrual: debits ${debits.toString()} vs credits ${credits.toString()} (gross ${totals.grossPay.toString()}, employer ${employerContributions.toString()}, PAYE ${totals.paye.toString()}, NSSF ${(totals.nssfEmployee + totals.nssfEmployer).toString()}, SHIF ${totals.shifEmployee.toString()}, AHL ${(totals.ahlEmployee + totals.ahlEmployer).toString()}, net ${totals.netPay.toString()}). Refusing to post; this is a defect in the payslip figures, not a rounding to absorb.`,
      );
    }

    const period = `${run.periodYear.toString()}-${run.periodMonth.toString().padStart(2, "0")}`;
    const entry = await postJournalEntryWithinTransaction(tx, schema, {
      entryDate: run.payDate,
      description: `Payroll accrual ${period} — run ${run.runNumber.toString()} (${run.payslips.length.toString()} employee${run.payslips.length === 1 ? "" : "s"}, ${run.statutorySchedule.label})`,
      reference: `PAYROLL-${run.runNumber.toString()}`,
      source: "PAYROLL",
      sourceId: run.id,
      createdBy: postedById,
      lines,
    });

    await tx.payrollRun.update({
      where: { id: run.id },
      data: { status: "POSTED", postedAt: new Date(), journalEntryId: entry.id },
    });

    const loaded = await tx.payrollRun.findUniqueOrThrow({
      where: { id: run.id },
      include: RUN_INCLUDE,
    });
    return toRunDetail(loaded);
  });
}

/**
 * FLIP A POSTED RUN TO PAID — the one write to `payroll_runs` that settlement needs.
 *
 * Called ONLY by `src/services/payroll-settlement.ts`, INSIDE the transaction that has
 * just written the run's net-pay settlement and posted `Dr 2120 / Cr cash`. It lives
 * here rather than there so this file stays the sole writer of `payroll_runs`, the
 * same seam as `recordSaleWithinTransaction` and `transferStockWithinTransaction`:
 * a caller that needs atomicity composes into its own transaction instead of growing a
 * second writer.
 *
 * Migration 0022's state machine refuses POSTED -> PAID unless the settlement row
 * already exists, so calling this before writing the settlement fails loudly.
 */
export async function markPayrollRunPaidWithinTransaction(
  tx: LedgerTx,
  runId: string,
): Promise<void> {
  const run = await tx.payrollRun.findUnique({
    where: { id: runId },
    select: { runNumber: true, status: true },
  });
  if (run === null) {
    throw new PayrollValidationError(`Unknown payroll run ${runId}.`);
  }
  if (run.status !== "POSTED") {
    throw new PayrollStateError(
      `Payroll run ${run.runNumber.toString()} is ${run.status}: only a POSTED run can become PAID.`,
    );
  }
  await tx.payrollRun.update({ where: { id: runId }, data: { status: "PAID" } });
}

/**
 * Cancel a run that has not been posted.
 *
 * **A POSTED RUN CANNOT BE CANCELLED.** The accrual is booked, every employee has a
 * net-pay claim and three authorities are owed — "this payroll never happened" is
 * false, and once PAID money has left the business as well. The correction is a
 * reversing entry. Migration 0022's state machine refuses it regardless of this check.
 *
 * Cancelling frees the month: the partial unique index excludes CANCELLED runs, so a
 * corrected payroll can be created for the same period.
 */
export async function cancelPayrollRun(
  db: TenantPrismaClient,
  id: string,
  reason: string,
): Promise<PayrollRunDetail> {
  const schema = resolveSchema(db);

  return db.$transaction(async (tx) => {
    const run = await lockRun(tx, schema, id);
    if (run.status === "CANCELLED") {
      throw new PayrollStateError(
        `Payroll run ${run.runNumber.toString()} is already cancelled.`,
      );
    }
    if (run.status === "POSTED" || run.status === "PAID") {
      throw new PayrollStateError(
        `Payroll run ${run.runNumber.toString()} is ${run.status} and cannot be cancelled: the accrual is booked${run.status === "PAID" ? " and the net pay has already left the business" : ", every employee has a net-pay claim and PAYE, NSSF and SHA are owed"}. The correction is a reversing entry, never a cancellation.`,
      );
    }
    const note = run.notes === null ? `Cancelled: ${reason}` : `${run.notes}\nCancelled: ${reason}`;
    await tx.payrollRun.update({
      where: { id: run.id },
      data: { status: "CANCELLED", notes: note },
    });
    const loaded = await tx.payrollRun.findUniqueOrThrow({
      where: { id: run.id },
      include: RUN_INCLUDE,
    });
    return toRunDetail(loaded);
  });
}

// ---------------------------------------------------------------------------
// 4. Reads
// ---------------------------------------------------------------------------

export interface ListPayrollRunFilters {
  status?: PayrollRunStatus;
  periodYear?: number;
}

export async function listPayrollRuns(
  db: TenantPrismaClient,
  filters: ListPayrollRunFilters = {},
): Promise<PayrollRunRow[]> {
  const runs = await db.payrollRun.findMany({
    where: {
      ...(filters.status !== undefined ? { status: filters.status } : {}),
      ...(filters.periodYear !== undefined ? { periodYear: filters.periodYear } : {}),
    },
    include: RUN_INCLUDE,
    orderBy: { runNumber: "desc" },
  });
  return runs.map(toRunRow);
}

export async function getPayrollRun(
  db: TenantPrismaClient,
  id: string,
): Promise<PayrollRunDetail | null> {
  const run = await db.payrollRun.findUnique({ where: { id }, include: RUN_INCLUDE });
  return run === null ? null : toRunDetail(run);
}

export async function listPayslipsForRun(
  db: TenantPrismaClient,
  runId: string,
): Promise<PayslipRow[] | null> {
  const run = await db.payrollRun.findUnique({ where: { id: runId }, select: { id: true } });
  if (run === null) {
    return null;
  }
  const payslips = await db.payslip.findMany({
    where: { payrollRunId: runId },
    include: PAYSLIP_INCLUDE,
    orderBy: { createdAt: "asc" },
  });
  return payslips.map(toPayslipRow);
}

export async function getPayslip(
  db: TenantPrismaClient,
  id: string,
): Promise<PayslipRow | null> {
  const payslip = await db.payslip.findUnique({ where: { id }, include: PAYSLIP_INCLUDE });
  return payslip === null ? null : toPayslipRow(payslip);
}

/** Re-exported so routes can map engine failures without importing the pure module. */
export { PayrollInputError, PayrollRulesetError };
