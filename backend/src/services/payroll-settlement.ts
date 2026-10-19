// ===========================================================================
// PAYROLL SETTLEMENT — NET PAY AND STATUTORY REMITTANCES (Module 8, Task 8.2).
//
// THIS IS THE ONLY MODULE PERMITTED TO WRITE `net_pay_payments`,
// `net_pay_payment_lines` OR `statutory_remittances`, and the only module that posts
// payroll SETTLEMENT GL.
//
// Task 8.1 left a POSTED run whose accrual sits as credit balances in five
// liabilities. This moves them to cash, and does nothing else:
//
//   NET PAY      Dr 2120 Net Salaries Payable           Σ the run's netPay
//                Cr 1000 | 1020 | 1010                  by settlement method
//
//   REMITTANCE   Dr 2200 PAYE | 2210 NSSF | 2220 SHA | 2230 Housing Levy
//                Cr 1000 | 1020 | 1010                  by remittance method
//
// WHAT IT MUST NEVER DO:
//   * IT NEVER WRITES A STOCK TABLE AND NEVER POSTS TO ACCOUNT 1200. Paying people
//     and authorities is not a stock movement; `sum(Product.stockValue) = GL(1200)` is
//     untouched by every settlement.
//   * IT NEVER TOUCHES A REVENUE OR EXPENSE ACCOUNT. The cost of employment was
//     recognised by the ACCRUAL (6020 / 6025); paying it is the same cost leaving the
//     bank, not a second one. Every entry here is ONE liability debit and ONE cash
//     credit — the account codes this file names are exactly the five payroll
//     liabilities and the three cash accounts.
//   * IT NEVER WRITES `payroll_runs`. `src/services/payroll.ts` stays the sole writer;
//     the POSTED -> PAID flip goes through its `markPayrollRunPaidWithinTransaction`,
//     composed into this module's transaction.
//   * IT WRITES NO JOURNAL TABLE ITSELF. Every posting goes through
//     `postJournalEntryWithinTransaction`.
//
// THE FULL-CYCLE INVARIANT: once a run's net is settled and each of its four heads is
// remitted in full against it, all five liabilities net to ZERO for that run, and the
// cash credited equals `Σ gross + Σ employer contributions` — the accrual's own debit
// side. That is what "this payroll is finished" means in the books.
// ===========================================================================

import { randomUUID } from "node:crypto";
import type { PrismaClient as TenantPrismaClient } from "../generated/tenant/client";
import type {
  EmployeePaymentMethod,
  PayrollSettlementMethod,
  StatutoryType,
} from "../generated/tenant/enums";
import { assertValidSchemaName, tenantSchemaFor } from "../db/tenant";
import type { Cents } from "../lib/money";
import {
  postJournalEntryWithinTransaction,
  type JournalLineInput,
  type LedgerTx,
} from "./ledger";
import {
  markPayrollRunPaidWithinTransaction,
  PayrollStateError,
  PayrollValidationError,
} from "./payroll";

/** The run or remittance does not exist in THIS tenant's schema. Route -> 404. */
export class PayrollNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayrollNotFoundError";
  }
}

// The only accounts a settlement may touch: the five payroll liabilities as DEBITS,
// the three cash accounts as CREDITS. Nothing else appears in this file.
const ACCT_NET_SALARIES = "2120";

/** The liability account each statutory head was accrued to by Task 8.1. */
export const STATUTORY_ACCOUNT: Readonly<Record<StatutoryType, string>> = {
  PAYE: "2200",
  NSSF: "2210",
  SHIF: "2220",
  HOUSING_LEVY: "2230",
};

/** The authority each head is remitted to — recorded so a report can say who was paid. */
export const STATUTORY_AUTHORITY: Readonly<Record<StatutoryType, string>> = {
  PAYE: "KRA",
  NSSF: "NSSF",
  SHIF: "SHA",
  HOUSING_LEVY: "KRA",
};

/** Credit accounts by settlement method. CASH / BANK / MPESA, nothing else. */
const SETTLEMENT_CREDIT_ACCOUNT: Readonly<Record<PayrollSettlementMethod, string>> = {
  CASH: "1000",
  BANK: "1020",
  MPESA: "1010",
};

function resolveSchema(db: TenantPrismaClient): string {
  const schema = tenantSchemaFor(db);
  assertValidSchemaName(schema);
  return schema;
}

function periodLabel(year: number, month: number): string {
  return `${year.toString()}-${month.toString().padStart(2, "0")}`;
}

/**
 * ASSERT A SETTLEMENT ENTRY BALANCES BEFORE IT IS POSTED, AND FAIL LOUDLY IF NOT.
 *
 * Every settlement is ONE debit and ONE credit of the same figure, so this cannot fire
 * unless the code building the legs is wrong — which is exactly when it is worth
 * having. The ledger's deferred constraint would also refuse an imbalance at COMMIT,
 * but without saying which settlement produced it.
 */
function assertBalanced(lines: ReadonlyArray<JournalLineInput>, what: string): void {
  const debits = lines.reduce((sum, line) => sum + (line.debit ?? 0n), 0n);
  const credits = lines.reduce((sum, line) => sum + (line.credit ?? 0n), 0n);
  if (debits !== credits || lines.length !== 2) {
    throw new Error(
      `${what} would post an unbalanced or malformed settlement: ${lines.length.toString()} line(s), debits ${debits.toString()} vs credits ${credits.toString()}. Refusing to post; a settlement is exactly one liability debit and one cash credit of the same amount.`,
    );
  }
}

/**
 * The credit balance of a payroll liability account across the whole ledger, in
 * cents. Schema-qualified raw SQL: the pg adapter does not set search_path.
 */
async function liabilityBalance(tx: LedgerTx, schema: string, accountCode: string): Promise<Cents> {
  assertValidSchemaName(schema);
  const rows = await tx.$queryRawUnsafe<Array<{ balance: bigint }>>(
    `SELECT (COALESCE(SUM(l."credit"), 0) - COALESCE(SUM(l."debit"), 0))::bigint AS balance
       FROM "${schema}".journal_lines l
       JOIN "${schema}".accounts a ON a."id" = l."accountId"
      WHERE a."code" = $1`,
    accountCode,
  );
  return rows[0]?.balance ?? 0n;
}

/**
 * What one journal entry credited (net of debits) to one account, in cents. Used to
 * read what a run's ACCRUAL owes each head — straight from the posted entry, so the
 * figure is the ledger's own rather than a re-summation that could disagree with it.
 */
async function creditedByEntry(
  db: TenantPrismaClient | LedgerTx,
  entryId: string,
  accountCode: string,
): Promise<Cents> {
  const lines = await db.journalLine.findMany({
    where: { entryId, account: { code: accountCode } },
    select: { debit: true, credit: true },
  });
  return lines.reduce((sum, line) => sum + line.credit - line.debit, 0n);
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface NetPayPaymentLineRow {
  id: string;
  payslipId: string;
  employeeId: string;
  employeeNumber: number;
  employeeName: string;
  amount: Cents;
  method: EmployeePaymentMethod;
  bankName: string | null;
  bankAccount: string | null;
}

export interface NetPayPaymentRow {
  id: string;
  payrollRunId: string;
  runNumber: number;
  periodYear: number;
  periodMonth: number;
  paymentDate: Date;
  method: PayrollSettlementMethod;
  debitAccountCode: string;
  creditAccountCode: string;
  totalNet: Cents;
  reference: string | null;
  notes: string | null;
  journalEntryId: string | null;
  createdById: string;
  createdAt: Date;
  lines: NetPayPaymentLineRow[];
}

export interface StatutoryRemittanceRow {
  id: string;
  statutoryType: StatutoryType;
  authority: string;
  debitAccountCode: string;
  creditAccountCode: string;
  amount: Cents;
  remittanceDate: Date;
  method: PayrollSettlementMethod;
  reference: string | null;
  notes: string | null;
  payrollRunId: string | null;
  payrollRunNumber: number | null;
  journalEntryId: string;
  createdById: string;
  createdAt: Date;
}

const NET_PAYMENT_INCLUDE = {
  payrollRun: { select: { runNumber: true, periodYear: true, periodMonth: true } },
  lines: {
    include: { employee: { select: { employeeNumber: true, firstName: true, lastName: true } } },
    orderBy: { employee: { employeeNumber: "asc" } },
  },
} as const;

interface RawNetPayment {
  id: string;
  payrollRunId: string;
  paymentDate: Date;
  method: PayrollSettlementMethod;
  totalNet: bigint;
  reference: string | null;
  notes: string | null;
  journalEntryId: string | null;
  createdById: string;
  createdAt: Date;
  payrollRun: { runNumber: number; periodYear: number; periodMonth: number };
  lines: Array<{
    id: string;
    payslipId: string;
    employeeId: string;
    amount: bigint;
    method: EmployeePaymentMethod;
    bankName: string | null;
    bankAccount: string | null;
    employee: { employeeNumber: number; firstName: string; lastName: string };
  }>;
}

function toNetPaymentRow(payment: RawNetPayment): NetPayPaymentRow {
  return {
    id: payment.id,
    payrollRunId: payment.payrollRunId,
    runNumber: payment.payrollRun.runNumber,
    periodYear: payment.payrollRun.periodYear,
    periodMonth: payment.payrollRun.periodMonth,
    paymentDate: payment.paymentDate,
    method: payment.method,
    debitAccountCode: ACCT_NET_SALARIES,
    creditAccountCode: SETTLEMENT_CREDIT_ACCOUNT[payment.method],
    totalNet: payment.totalNet,
    reference: payment.reference,
    notes: payment.notes,
    journalEntryId: payment.journalEntryId,
    createdById: payment.createdById,
    createdAt: payment.createdAt,
    lines: payment.lines.map((line) => ({
      id: line.id,
      payslipId: line.payslipId,
      employeeId: line.employeeId,
      employeeNumber: line.employee.employeeNumber,
      employeeName: `${line.employee.firstName} ${line.employee.lastName}`,
      amount: line.amount,
      method: line.method,
      bankName: line.bankName,
      bankAccount: line.bankAccount,
    })),
  };
}

const REMITTANCE_INCLUDE = { payrollRun: { select: { runNumber: true } } } as const;

interface RawRemittance {
  id: string;
  statutoryType: StatutoryType;
  amount: bigint;
  remittanceDate: Date;
  method: PayrollSettlementMethod;
  reference: string | null;
  notes: string | null;
  payrollRunId: string | null;
  journalEntryId: string;
  createdById: string;
  createdAt: Date;
  payrollRun: { runNumber: number } | null;
}

function toRemittanceRow(remittance: RawRemittance): StatutoryRemittanceRow {
  return {
    id: remittance.id,
    statutoryType: remittance.statutoryType,
    authority: STATUTORY_AUTHORITY[remittance.statutoryType],
    debitAccountCode: STATUTORY_ACCOUNT[remittance.statutoryType],
    creditAccountCode: SETTLEMENT_CREDIT_ACCOUNT[remittance.method],
    amount: remittance.amount,
    remittanceDate: remittance.remittanceDate,
    method: remittance.method,
    reference: remittance.reference,
    notes: remittance.notes,
    payrollRunId: remittance.payrollRunId,
    payrollRunNumber: remittance.payrollRun?.runNumber ?? null,
    journalEntryId: remittance.journalEntryId,
    createdById: remittance.createdById,
    createdAt: remittance.createdAt,
  };
}

// ---------------------------------------------------------------------------
// 1. Net-pay settlement
// ---------------------------------------------------------------------------

export interface SettleNetPayInput {
  paymentDate: Date;
  method: PayrollSettlementMethod;
  reference?: string;
  notes?: string;
  createdById: string;
}

/**
 * SETTLE A POSTED RUN'S NET PAY — ONE TRANSACTION.
 *
 *     Dr 2120 Net Salaries Payable     Σ the run's payslip netPay
 *     Cr 1000 | 1020 | 1010            by the settlement method
 *
 * In ONE transaction it posts the entry, writes the settlement and one audit line per
 * payslip, and flips the run to PAID. A run marked PAID with no settlement, or a
 * settlement with its run still POSTED, would each describe a payment that only half
 * happened; migration 0022 refuses both at COMMIT regardless of this code.
 *
 * `totalNet` IS NOT ACCEPTED FROM THE CALLER. It is derived from the run's frozen
 * payslips, which ARE the accrual entry — so the settlement can only ever pay exactly
 * what was accrued, and GL(2120) for the run returns to exactly zero.
 *
 * ONE SETTLEMENT PER RUN, ONE CASH ACCOUNT. The per-employee method, bank and account
 * are SNAPSHOTTED on the lines for the bank payment file a later task will build; the
 * ledger carries one credit because the money left one account.
 *
 * MPESA RECORDS, IT DOES NOT DISBURSE. There is no B2C payout here.
 */
export async function settleNetPay(
  db: TenantPrismaClient,
  runId: string,
  input: SettleNetPayInput,
): Promise<NetPayPaymentRow> {
  const schema = resolveSchema(db);

  return db.$transaction(async (tx) => {
    // Serialise concurrent settlements on the run row. The second sees PAID and is
    // refused here; the unique index on `payrollRunId` is the guarantee behind it.
    const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "${schema}".payroll_runs WHERE "id" = $1 FOR UPDATE`,
      runId,
    );
    if (locked[0] === undefined) {
      throw new PayrollNotFoundError(`No payroll run with id "${runId}".`);
    }

    const run = await tx.payrollRun.findUniqueOrThrow({
      where: { id: runId },
      include: {
        netPayPayment: { select: { id: true } },
        payslips: {
          include: {
            employee: {
              select: { paymentMethod: true, bankName: true, bankAccount: true },
            },
          },
        },
      },
    });

    if (run.netPayPayment !== null || run.status === "PAID") {
      throw new PayrollStateError(
        `Payroll run ${run.runNumber.toString()} has already been settled. One net-pay settlement per run: paying it again would pay every employee twice.`,
      );
    }
    if (run.status !== "POSTED") {
      throw new PayrollStateError(
        `Payroll run ${run.runNumber.toString()} is ${run.status}: only a POSTED run can have its net pay settled. ${run.status === "CANCELLED" ? "A cancelled run never happened." : "Post the accrual first — until then nothing is owed."}`,
      );
    }
    if (run.payslips.length === 0) {
      throw new PayrollValidationError(
        `Payroll run ${run.runNumber.toString()} has no payslips, so there is nothing to settle.`,
      );
    }

    const totalNet = run.payslips.reduce((sum, slip) => sum + slip.netPay, 0n);
    const period = periodLabel(run.periodYear, run.periodMonth);
    const paymentId = randomUUID();

    let journalEntryId: string | null = null;
    if (totalNet > 0n) {
      const lines: JournalLineInput[] = [
        {
          accountCode: ACCT_NET_SALARIES,
          debit: totalNet,
          memo: `Net pay settled for ${run.payslips.length.toString()} employee${run.payslips.length === 1 ? "" : "s"}`,
        },
        {
          accountCode: SETTLEMENT_CREDIT_ACCOUNT[input.method],
          credit: totalNet,
          memo: `Paid by ${input.method}`,
        },
      ];
      assertBalanced(lines, `Net-pay settlement of payroll run ${run.runNumber.toString()}`);
      const entry = await postJournalEntryWithinTransaction(tx, schema, {
        entryDate: input.paymentDate,
        description: `Net pay settlement ${period} — run ${run.runNumber.toString()}`,
        reference: input.reference ?? `PAYROLL-${run.runNumber.toString()}-NET`,
        source: "PAYROLL",
        sourceId: paymentId,
        createdBy: input.createdById,
        lines,
      });
      journalEntryId = entry.id;
    }

    await tx.netPayPayment.create({
      data: {
        id: paymentId,
        payrollRunId: run.id,
        paymentDate: input.paymentDate,
        method: input.method,
        totalNet,
        ...(input.reference !== undefined ? { reference: input.reference } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        journalEntryId,
        createdById: input.createdById,
        lines: {
          create: run.payslips.map((slip) => ({
            payslipId: slip.id,
            employeeId: slip.employeeId,
            amount: slip.netPay,
            method: slip.employee.paymentMethod,
            bankName: slip.employee.bankName,
            bankAccount: slip.employee.bankAccount,
          })),
        },
      },
    });

    await markPayrollRunPaidWithinTransaction(tx, run.id);

    const created = await tx.netPayPayment.findUniqueOrThrow({
      where: { id: paymentId },
      include: NET_PAYMENT_INCLUDE,
    });
    return toNetPaymentRow(created);
  });
}

/** The net-pay settlement of one run, or null if the run is unknown or not yet settled. */
export async function getNetPayPaymentForRun(
  db: TenantPrismaClient,
  runId: string,
): Promise<NetPayPaymentRow | null> {
  const payment = await db.netPayPayment.findUnique({
    where: { payrollRunId: runId },
    include: NET_PAYMENT_INCLUDE,
  });
  return payment === null ? null : toNetPaymentRow(payment);
}

// ---------------------------------------------------------------------------
// 2. Statutory remittance
// ---------------------------------------------------------------------------

export interface RecordStatutoryRemittanceInput {
  statutoryType: StatutoryType;
  amount: Cents;
  remittanceDate: Date;
  method: PayrollSettlementMethod;
  reference?: string;
  notes?: string;
  payrollRunId?: string;
  createdById: string;
}

/**
 * REMIT ONE STATUTORY HEAD TO ITS AUTHORITY — ONE TRANSACTION.
 *
 *     Dr 2200 PAYE | 2210 NSSF | 2220 SHA | 2230 Housing Levy     by head
 *     Cr 1000 | 1020 | 1010                                        by method
 *
 * TWO REFUSALS, both checked here with a message naming the figures and again by
 * migration 0022's deferred constraint at COMMIT:
 *
 *   * **YOU CANNOT REMIT MORE THAN YOU OWE.** The amount may not exceed the head's
 *     current GL credit balance. Overpaying would leave a statutory liability in a
 *     DEBIT balance — an unexplained receivable from KRA, NSSF or SHA.
 *   * **A RUN CANNOT BE REMITTED BEYOND ITS OWN ACCRUAL.** When tagged to a run, the
 *     remittances against that run for the head may not exceed what the run's accrual
 *     entry credited to it, or the per-run tie-out would read over-settled.
 *
 * Concurrent remittances of the SAME head serialise on a transaction-scoped advisory
 * lock keyed by schema and head, so two of them cannot each read the same balance and
 * together overpay it. It locks no row, so the payroll accrual and every other posting
 * to the account proceed unblocked.
 */
export async function recordStatutoryRemittance(
  db: TenantPrismaClient,
  input: RecordStatutoryRemittanceInput,
): Promise<StatutoryRemittanceRow> {
  const schema = resolveSchema(db);
  if (input.amount <= 0n) {
    throw new PayrollValidationError("A remittance amount must be positive.");
  }
  const headAccount = STATUTORY_ACCOUNT[input.statutoryType];

  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      `${schema}:statutory-remittance:${headAccount}`,
    );

    let runLabel = "";
    if (input.payrollRunId !== undefined) {
      const run = await tx.payrollRun.findUnique({
        where: { id: input.payrollRunId },
        select: {
          id: true,
          runNumber: true,
          periodYear: true,
          periodMonth: true,
          status: true,
          journalEntryId: true,
        },
      });
      if (run === null) {
        throw new PayrollNotFoundError(`No payroll run with id "${input.payrollRunId}".`);
      }
      if ((run.status !== "POSTED" && run.status !== "PAID") || run.journalEntryId === null) {
        throw new PayrollStateError(
          `Payroll run ${run.runNumber.toString()} is ${run.status}: only a POSTED or PAID run has accrued anything to remit.`,
        );
      }
      const accrued = await creditedByEntry(tx, run.journalEntryId, headAccount);
      const already = await tx.statutoryRemittance.aggregate({
        where: { payrollRunId: run.id, statutoryType: input.statutoryType },
        _sum: { amount: true },
      });
      const remitted = already._sum.amount ?? 0n;
      if (remitted + input.amount > accrued) {
        throw new PayrollValidationError(
          `Remitting ${input.amount.toString()} cents of ${input.statutoryType} against payroll run ${run.runNumber.toString()} would exceed what that run accrued for the head: accrued ${accrued.toString()}, already remitted ${remitted.toString()}, so at most ${(accrued - remitted).toString()} cents remain.`,
        );
      }
      runLabel = ` — run ${run.runNumber.toString()} (${periodLabel(run.periodYear, run.periodMonth)})`;
    }

    const owed = await liabilityBalance(tx, schema, headAccount);
    if (input.amount > owed) {
      throw new PayrollValidationError(
        `Remitting ${input.amount.toString()} cents of ${input.statutoryType} would exceed what the business owes: account ${headAccount} carries a credit balance of ${owed.toString()} cents. You cannot remit more than you owe.`,
      );
    }

    const remittanceId = randomUUID();
    const lines: JournalLineInput[] = [
      {
        accountCode: headAccount,
        debit: input.amount,
        memo: `${input.statutoryType} remitted to ${STATUTORY_AUTHORITY[input.statutoryType]}`,
      },
      {
        accountCode: SETTLEMENT_CREDIT_ACCOUNT[input.method],
        credit: input.amount,
        memo: `Paid by ${input.method}`,
      },
    ];
    assertBalanced(lines, `${input.statutoryType} remittance`);
    const entry = await postJournalEntryWithinTransaction(tx, schema, {
      entryDate: input.remittanceDate,
      description: `${input.statutoryType} remittance to ${STATUTORY_AUTHORITY[input.statutoryType]}${runLabel}`,
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
      source: "PAYROLL",
      sourceId: remittanceId,
      createdBy: input.createdById,
      lines,
    });

    const created = await tx.statutoryRemittance.create({
      data: {
        id: remittanceId,
        statutoryType: input.statutoryType,
        amount: input.amount,
        remittanceDate: input.remittanceDate,
        method: input.method,
        ...(input.reference !== undefined ? { reference: input.reference } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.payrollRunId !== undefined ? { payrollRunId: input.payrollRunId } : {}),
        journalEntryId: entry.id,
        createdById: input.createdById,
      },
      include: REMITTANCE_INCLUDE,
    });
    return toRemittanceRow(created);
  });
}

export interface ListStatutoryRemittanceFilters {
  statutoryType?: StatutoryType;
  payrollRunId?: string;
  /** Inclusive lower bound on `remittanceDate`. */
  from?: Date;
  /** Inclusive upper bound on `remittanceDate`. */
  to?: Date;
}

export async function listStatutoryRemittances(
  db: TenantPrismaClient,
  filters: ListStatutoryRemittanceFilters = {},
): Promise<StatutoryRemittanceRow[]> {
  const remittances = await db.statutoryRemittance.findMany({
    where: {
      ...(filters.statutoryType !== undefined ? { statutoryType: filters.statutoryType } : {}),
      ...(filters.payrollRunId !== undefined ? { payrollRunId: filters.payrollRunId } : {}),
      ...(filters.from !== undefined || filters.to !== undefined
        ? {
            remittanceDate: {
              ...(filters.from !== undefined ? { gte: filters.from } : {}),
              ...(filters.to !== undefined ? { lte: filters.to } : {}),
            },
          }
        : {}),
    },
    include: REMITTANCE_INCLUDE,
    orderBy: [{ remittanceDate: "desc" }, { createdAt: "desc" }],
  });
  return remittances.map(toRemittanceRow);
}

export async function getStatutoryRemittance(
  db: TenantPrismaClient,
  id: string,
): Promise<StatutoryRemittanceRow | null> {
  const remittance = await db.statutoryRemittance.findUnique({
    where: { id },
    include: REMITTANCE_INCLUDE,
  });
  return remittance === null ? null : toRemittanceRow(remittance);
}

// ---------------------------------------------------------------------------
// 3. A run's settlement position — read by the filing summaries
// ---------------------------------------------------------------------------

export interface HeadPosition {
  statutoryType: StatutoryType;
  accountCode: string;
  /** What the run's accrual entry credited to the head. NULL before the run is posted. */
  accrued: Cents | null;
  /** Remittances TAGGED to this run for the head. */
  remitted: Cents;
  /** accrued − remitted; NULL before the run is posted. */
  outstanding: Cents | null;
}

/**
 * Per head, what a run accrued (from its posted entry), what has been remitted against
 * it, and what remains. Read-only: the filing summaries use it to tie each schedule to
 * the ledger as well as to the payslips.
 */
export async function runHeadPositions(
  db: TenantPrismaClient,
  run: { id: string; journalEntryId: string | null },
): Promise<Record<StatutoryType, HeadPosition>> {
  const grouped = await db.statutoryRemittance.groupBy({
    by: ["statutoryType"],
    where: { payrollRunId: run.id },
    _sum: { amount: true },
  });
  const remittedBy = new Map<StatutoryType, Cents>(
    grouped.map((g) => [g.statutoryType, g._sum.amount ?? 0n]),
  );

  const position = async (type: StatutoryType): Promise<HeadPosition> => {
    const accountCode = STATUTORY_ACCOUNT[type];
    const accrued =
      run.journalEntryId === null ? null : await creditedByEntry(db, run.journalEntryId, accountCode);
    const remitted = remittedBy.get(type) ?? 0n;
    return {
      statutoryType: type,
      accountCode,
      accrued,
      remitted,
      outstanding: accrued === null ? null : accrued - remitted,
    };
  };

  return {
    PAYE: await position("PAYE"),
    NSSF: await position("NSSF"),
    SHIF: await position("SHIF"),
    HOUSING_LEVY: await position("HOUSING_LEVY"),
  };
}

/** What a run's accrual credited to 2120, or null before posting. */
export async function runNetAccrued(
  db: TenantPrismaClient,
  run: { journalEntryId: string | null },
): Promise<Cents | null> {
  return run.journalEntryId === null
    ? null
    : creditedByEntry(db, run.journalEntryId, ACCT_NET_SALARIES);
}
