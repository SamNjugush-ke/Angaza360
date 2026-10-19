// ===========================================================================
// Double-Entry General Ledger Engine (Module 5, Task 2.2).
//
// THIS IS THE ONLY MODULE IN THE ENTIRE CODEBASE PERMITTED TO WRITE
// journal_entries OR journal_lines. No other file may insert, update, or delete
// those tables, and no convenience helper that does may be added elsewhere.
// Every other financial module posts through postJournalEntry / reverseJournalEntry.
//
// The database-level triggers in migration 0003 are the real guarantee of
// balance, immutability, period locking, and chart protection. The
// application-level checks here exist only so callers get a clear error in the
// common case; they never replace or weaken the DB side.
// ===========================================================================

import type { PrismaClient as TenantPrismaClient } from "../generated/tenant/client";
import type {
  AccountClass,
  JournalEntryStatus,
  JournalSource,
  NormalBalance,
} from "../generated/tenant/enums";
import type { Cents } from "../lib/money";
import { assertValidSchemaName, tenantSchemaFor } from "../db/tenant";
import { businessDateOf } from "../lib/business-time";
// THE PERIOD-CLOSE GUARD (Task OFF.1). The RULE — which devices could still
// deliver sales dated inside a period — belongs to the offline module, which owns
// devices and leases. The REFUSAL belongs here, because closing a period is a
// ledger act and the check must hold for every caller rather than only for the
// route that remembered to ask. That module imports nothing from this one at
// runtime (it takes LedgerTx as a type only), so this is a seam, not a cycle.
import {
  findDevicesBlockingPeriodClose,
  PeriodCloseBlockedError,
} from "./offline/custody";

export interface JournalLineInput {
  accountCode: string; // resolved to accountId by the service
  debit?: Cents;
  credit?: Cents;
  memo?: string;
}

export interface PostEntryInput {
  entryDate: Date;
  description: string;
  reference?: string;
  source: JournalSource;
  sourceId?: string;
  createdBy: string;
  lines: JournalLineInput[];
}

export interface JournalLineResult {
  id: string;
  lineNumber: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: Cents;
  credit: Cents;
  memo: string | null;
}

export interface JournalEntryResult {
  id: string;
  entryNumber: string;
  entryDate: Date;
  periodYear: number;
  periodMonth: number;
  description: string;
  reference: string | null;
  source: JournalSource;
  sourceId: string | null;
  status: JournalEntryStatus;
  reversesEntryId: string | null;
  reversedByEntryId: string | null;
  createdBy: string;
  postedAt: Date;
  lines: JournalLineResult[];
}

export interface TrialBalanceRow {
  code: string;
  name: string;
  accountClass: AccountClass;
  normalBalance: NormalBalance;
  totalDebit: Cents;
  totalCredit: Cents;
  balance: Cents;
}

export interface AccountLedgerRow {
  entryId: string;
  entryNumber: string;
  entryDate: Date;
  lineNumber: number;
  description: string;
  source: JournalSource;
  status: JournalEntryStatus;
  debit: Cents;
  credit: Cents;
  runningBalance: Cents;
}

export interface AccountLedgerResult {
  account: {
    code: string;
    name: string;
    accountClass: AccountClass;
    normalBalance: NormalBalance;
  };
  openingBalance: Cents;
  closingBalance: Cents;
  rows: AccountLedgerRow[];
  pagination: { take: number; skip: number; total: number };
}

export interface AccountingPeriodResult {
  id: string;
  year: number;
  month: number;
  status: "OPEN" | "CLOSED";
  closedAt: Date | null;
  closedBy: string | null;
}

// ---- Error types the route layer maps to HTTP codes ----

/** Application-level validation failure (bad lines, unknown/inactive account, imbalance caught before commit). Route -> 400. */
export class LedgerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerValidationError";
  }
}

/** The DB balance/line trigger rejected the transaction. Route -> 400. Should be unreachable given the app checks, but never assumed so. */
export class LedgerImbalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerImbalanceError";
  }
}

/** The target accounting period is CLOSED. Route -> 409. */
export class PeriodClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeriodClosedError";
  }
}

// ---- internal helpers ----

function deriveYearMonth(date: Date): { year: number; month: number } {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

// THE ACCOUNTING DAY OF AN ENTRY (Task H.1). Every entryDate, reversal date and
// report boundary passes through here. It cuts the day in the BUSINESS time zone, not
// in UTC: a sale at 01:30 in Nairobi on 1 November is a November entry, while the old
// UTC cut posted it to 31 October — and on a month boundary into the wrong period.
// A value that is already a business date (00:00 UTC, as parsed from YYYY-MM-DD)
// maps to itself, so callers may pass either an instant or a date. See
// src/lib/business-time.ts.
function toBusinessDate(date: Date): Date {
  return businessDateOf(date);
}

function formatEntryNumber(year: number, month: number, seq: bigint): string {
  return `JE-${year}${String(month).padStart(2, "0")}-${seq.toString().padStart(6, "0")}`;
}

interface RawEntryWithLines {
  id: string;
  entryNumber: string;
  entryDate: Date;
  periodYear: number;
  periodMonth: number;
  description: string;
  reference: string | null;
  source: JournalSource;
  sourceId: string | null;
  status: JournalEntryStatus;
  reversesEntryId: string | null;
  reversedByEntryId: string | null;
  createdBy: string;
  postedAt: Date;
  lines: Array<{
    id: string;
    lineNumber: number;
    accountId: string;
    debit: bigint;
    credit: bigint;
    memo: string | null;
    account: { code: string; name: string };
  }>;
}

function mapEntry(entry: RawEntryWithLines): JournalEntryResult {
  const lines = [...entry.lines]
    .sort((a, b) => a.lineNumber - b.lineNumber)
    .map((line) => ({
      id: line.id,
      lineNumber: line.lineNumber,
      accountId: line.accountId,
      accountCode: line.account.code,
      accountName: line.account.name,
      debit: line.debit,
      credit: line.credit,
      memo: line.memo,
    }));

  return {
    id: entry.id,
    entryNumber: entry.entryNumber,
    entryDate: entry.entryDate,
    periodYear: entry.periodYear,
    periodMonth: entry.periodMonth,
    description: entry.description,
    reference: entry.reference,
    source: entry.source,
    sourceId: entry.sourceId,
    status: entry.status,
    reversesEntryId: entry.reversesEntryId,
    reversedByEntryId: entry.reversedByEntryId,
    createdBy: entry.createdBy,
    postedAt: entry.postedAt,
    lines,
  };
}

// Translate a raw Postgres/trigger error into the typed ledger errors. Any of
// our own typed errors thrown inside the transaction pass straight through.
async function withLedgerErrorTranslation<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (
      error instanceof LedgerValidationError ||
      error instanceof LedgerImbalanceError ||
      error instanceof PeriodClosedError
    ) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/is CLOSED/.test(message)) {
      throw new PeriodClosedError(message);
    }
    if (/must have at least two lines|is unbalanced/.test(message)) {
      throw new LedgerImbalanceError(message);
    }
    if (/journal_line_single_sided/.test(message)) {
      throw new LedgerValidationError(message);
    }
    throw error;
  }
}

// The tenant schema must be resolved for the client and validated before it is
// ever interpolated into raw SQL — the adapter does not set search_path, so
// unqualified raw SQL cannot see tenant objects.
function resolveSchema(db: TenantPrismaClient): string {
  const schema = tenantSchemaFor(db);
  assertValidSchemaName(schema);
  return schema;
}

async function nextEntrySeq(
  tx: Pick<TenantPrismaClient, "$queryRawUnsafe">,
  schema: string,
): Promise<bigint> {
  const rows = await tx.$queryRawUnsafe<Array<{ v: bigint }>>(
    `SELECT nextval('"${schema}".journal_entry_seq') AS v`,
  );
  const first = rows[0];
  if (first === undefined) {
    throw new Error("Failed to allocate a journal entry number from journal_entry_seq.");
  }
  return first.v;
}

// The transaction client type Prisma passes to the $transaction callback.
// Exported so other services (e.g. inventory) can post journal entries within
// their OWN transaction via postJournalEntryWithinTransaction, keeping stock
// and ledger moves atomic.
export type LedgerTx = Parameters<Parameters<TenantPrismaClient["$transaction"]>[0]>[0];

async function ensurePeriodOpen(
  tx: LedgerTx,
  year: number,
  month: number,
): Promise<void> {
  const period = await tx.accountingPeriod.findUnique({
    where: { year_month: { year, month } },
    select: { status: true },
  });
  if (period === null) {
    await tx.accountingPeriod.create({ data: { year, month, status: "OPEN" } });
    return;
  }
  if (period.status === "CLOSED") {
    throw new PeriodClosedError(
      `Accounting period ${year}-${String(month).padStart(2, "0")} is CLOSED; no entries may be posted to it.`,
    );
  }
}

// ---- public API ----

// Application-level validation (ergonomics; the DB constraint is the guarantee).
function validateBalancedLines(input: PostEntryInput): void {
  if (input.lines.length < 2) {
    throw new LedgerValidationError("A journal entry requires at least two lines.");
  }

  let sumDebit = 0n;
  let sumCredit = 0n;
  input.lines.forEach((line, index) => {
    const debit = line.debit ?? 0n;
    const credit = line.credit ?? 0n;
    if (debit < 0n || credit < 0n) {
      throw new LedgerValidationError(
        `Line ${index + 1}: debit and credit must be non-negative.`,
      );
    }
    const debitPositive = debit > 0n;
    const creditPositive = credit > 0n;
    if (debitPositive === creditPositive) {
      throw new LedgerValidationError(
        `Line ${index + 1}: exactly one of debit or credit must be positive.`,
      );
    }
    sumDebit += debit;
    sumCredit += credit;
  });

  if (sumDebit !== sumCredit) {
    throw new LedgerValidationError(
      `Entry is unbalanced: debits ${sumDebit.toString()} != credits ${sumCredit.toString()} (imbalance ${(sumDebit - sumCredit).toString()} cents).`,
    );
  }
}

// The core insert, run against an already-open transaction. It does NOT manage
// the transaction; the caller owns BEGIN/COMMIT and the error translation.
async function postJournalEntryCore(
  tx: LedgerTx,
  schema: string,
  input: PostEntryInput,
  entryDate: Date,
  year: number,
  month: number,
): Promise<JournalEntryResult> {
  const codes = Array.from(new Set(input.lines.map((line) => line.accountCode)));
  const accounts = await tx.account.findMany({ where: { code: { in: codes } } });
  const accountByCode = new Map(accounts.map((account) => [account.code, account]));

  for (const line of input.lines) {
    const account = accountByCode.get(line.accountCode);
    if (account === undefined) {
      throw new LedgerValidationError(`Unknown account code "${line.accountCode}".`);
    }
    if (!account.isActive) {
      throw new LedgerValidationError(
        `Account "${line.accountCode}" is inactive and cannot be posted to.`,
      );
    }
  }

  // Period must exist as OPEN (create if absent, refuse if CLOSED).
  await ensurePeriodOpen(tx, year, month);

  const seq = await nextEntrySeq(tx, schema);
  const entryNumber = formatEntryNumber(year, month, seq);

  const created = await tx.journalEntry.create({
    data: {
      entryNumber,
      entryDate,
      periodYear: year,
      periodMonth: month,
      description: input.description,
      reference: input.reference ?? null,
      source: input.source,
      sourceId: input.sourceId ?? null,
      createdBy: input.createdBy,
      lines: {
        create: input.lines.map((line, index) => {
          const account = accountByCode.get(line.accountCode);
          if (account === undefined) {
            // Already validated above; this keeps the type non-null.
            throw new LedgerValidationError(`Unknown account code "${line.accountCode}".`);
          }
          return {
            lineNumber: index + 1,
            accountId: account.id,
            debit: line.debit ?? 0n,
            credit: line.credit ?? 0n,
            memo: line.memo ?? null,
          };
        }),
      },
    },
    include: { lines: { include: { account: true } } },
  });

  return mapEntry(created);
}

export async function postJournalEntry(
  db: TenantPrismaClient,
  input: PostEntryInput,
): Promise<JournalEntryResult> {
  validateBalancedLines(input);

  const entryDate = toBusinessDate(input.entryDate);
  const { year, month } = deriveYearMonth(entryDate);
  const schema = resolveSchema(db);

  return withLedgerErrorTranslation(() =>
    db.$transaction((tx) =>
      // Returning through the transaction triggers COMMIT, at which the deferred
      // balance constraint fires; an imbalance is translated by the wrapper.
      postJournalEntryCore(tx, schema, input, entryDate, year, month),
    ),
  );
}

// Post a journal entry INSIDE a transaction the caller already opened, so a
// domain write (e.g. a stock movement) and its GL entry commit atomically.
// The caller must pass the resolved, validated tenant schema. The caller owns
// the transaction and therefore also owns the deferred-balance COMMIT error;
// application-level errors (validation, PeriodClosedError) throw synchronously
// here and propagate to roll the caller's transaction back.
export async function postJournalEntryWithinTransaction(
  tx: LedgerTx,
  schema: string,
  input: PostEntryInput,
): Promise<JournalEntryResult> {
  validateBalancedLines(input);
  assertValidSchemaName(schema);
  const entryDate = toBusinessDate(input.entryDate);
  const { year, month } = deriveYearMonth(entryDate);
  return postJournalEntryCore(tx, schema, input, entryDate, year, month);
}

// Core reversal, run against an already-open transaction. Does NOT manage the
// transaction. Used by the standalone entry point and by callers (POS void)
// that reverse several entries plus other effects in one transaction.
async function reverseJournalEntryCore(
  tx: LedgerTx,
  schema: string,
  entryId: string,
  reason: string,
  userId: string,
): Promise<JournalEntryResult> {
  const today = toBusinessDate(new Date());
  const { year, month } = deriveYearMonth(today);

  const original = await tx.journalEntry.findUnique({
    where: { id: entryId },
    include: { lines: { include: { account: true } } },
  });
  if (original === null) {
    throw new LedgerValidationError(`Journal entry ${entryId} not found.`);
  }
  if (original.status === "REVERSED") {
    throw new LedgerValidationError(
      `Journal entry ${original.entryNumber} is already reversed.`,
    );
  }

  // Reversal is dated TODAY, never backdated into a period that may be closed.
  await ensurePeriodOpen(tx, year, month);

  const seq = await nextEntrySeq(tx, schema);
  const entryNumber = formatEntryNumber(year, month, seq);

  const reversal = await tx.journalEntry.create({
    data: {
      entryNumber,
      entryDate: today,
      periodYear: year,
      periodMonth: month,
      description: `REVERSAL: ${reason}`,
      reference: original.reference,
      source: original.source,
      sourceId: original.sourceId,
      createdBy: userId,
      reversesEntryId: original.id,
      lines: {
        create: [...original.lines]
          .sort((a, b) => a.lineNumber - b.lineNumber)
          .map((line, index) => ({
            lineNumber: index + 1,
            accountId: line.accountId,
            // Swap debit and credit.
            debit: line.credit,
            credit: line.debit,
            memo: line.memo,
          })),
      },
    },
    include: { lines: { include: { account: true } } },
  });

  // Mark the original reversed. The immutability trigger permits exactly this
  // transition (reversedByEntryId NULL -> value, POSTED -> REVERSED).
  await tx.journalEntry.update({
    where: { id: original.id },
    data: { reversedByEntryId: reversal.id, status: "REVERSED" },
  });

  return mapEntry(reversal);
}

export async function reverseJournalEntry(
  db: TenantPrismaClient,
  entryId: string,
  reason: string,
  userId: string,
): Promise<JournalEntryResult> {
  const schema = resolveSchema(db);
  return withLedgerErrorTranslation(() =>
    db.$transaction((tx) => reverseJournalEntryCore(tx, schema, entryId, reason, userId)),
  );
}

// Reverse a journal entry INSIDE a transaction the caller already opened, so a
// void (which reverses several entries and returns stock) is one transaction.
export async function reverseJournalEntryWithinTransaction(
  tx: LedgerTx,
  schema: string,
  entryId: string,
  reason: string,
  userId: string,
): Promise<JournalEntryResult> {
  assertValidSchemaName(schema);
  return reverseJournalEntryCore(tx, schema, entryId, reason, userId);
}

interface TrialBalanceRawRow {
  code: string;
  name: string;
  accountClass: AccountClass;
  normalBalance: NormalBalance;
  total_debit: bigint;
  total_credit: bigint;
}

export async function getTrialBalance(
  db: TenantPrismaClient,
  asOf: Date,
): Promise<TrialBalanceRow[]> {
  return getTrialBalanceAsOf(db, resolveSchema(db), asOf);
}

/** Anything that can run a raw query: a tenant client OR an open transaction. */
export type LedgerReader = Pick<TenantPrismaClient, "$queryRawUnsafe">;

/**
 * THE balance query — cumulative debits and credits per account over every posted
 * line whose entry is dated on or before `asOf` (by `entryDate`, the GL's only
 * date). `getTrialBalance` and the financial statements (Module 13) both read through
 * it, so a statement can never compute a balance a different way than the ledger
 * holds it. It accepts a transaction as well as a client so a caller can read its
 * own uncommitted postings; it writes nothing.
 */
export async function getTrialBalanceAsOf(
  reader: LedgerReader,
  schema: string,
  asOf: Date,
): Promise<TrialBalanceRow[]> {
  assertValidSchemaName(schema);
  const asOfDate = toBusinessDate(asOf);
  const rows = await reader.$queryRawUnsafe<TrialBalanceRawRow[]>(
    `SELECT a.code,
            a.name,
            a."accountClass"  AS "accountClass",
            a."normalBalance" AS "normalBalance",
            COALESCE(SUM(jl.debit), 0)::bigint  AS total_debit,
            COALESCE(SUM(jl.credit), 0)::bigint AS total_credit
     FROM "${schema}".journal_lines jl
     JOIN "${schema}".accounts a         ON a.id  = jl."accountId"
     JOIN "${schema}".journal_entries je ON je.id = jl."entryId"
     WHERE je."entryDate" <= $1
     GROUP BY a.id, a.code, a.name, a."accountClass", a."normalBalance"
     HAVING COALESCE(SUM(jl.debit), 0) <> 0 OR COALESCE(SUM(jl.credit), 0) <> 0
     ORDER BY a.code ASC`,
    asOfDate,
  );

  return rows.map((row) => {
    const balance =
      row.normalBalance === "DEBIT"
        ? row.total_debit - row.total_credit
        : row.total_credit - row.total_debit;
    return {
      code: row.code,
      name: row.name,
      accountClass: row.accountClass,
      normalBalance: row.normalBalance,
      totalDebit: row.total_debit,
      totalCredit: row.total_credit,
      balance,
    };
  });
}

const DEFAULT_LEDGER_TAKE = 50;
const MAX_LEDGER_TAKE = 100;

interface OpeningRawRow {
  d: bigint;
  c: bigint;
}

export async function getAccountLedger(
  db: TenantPrismaClient,
  accountCode: string,
  from: Date | undefined,
  to: Date | undefined,
  take: number,
  skip: number,
): Promise<AccountLedgerResult> {
  const clampedTake = Number.isInteger(take)
    ? Math.min(MAX_LEDGER_TAKE, Math.max(1, take))
    : DEFAULT_LEDGER_TAKE;
  const clampedSkip = Number.isInteger(skip) && skip >= 0 ? skip : 0;

  const schema = resolveSchema(db);
  const account = await db.account.findUnique({ where: { code: accountCode } });
  if (account === null) {
    throw new LedgerValidationError(`Unknown account code "${accountCode}".`);
  }

  const fromDate = from === undefined ? undefined : toBusinessDate(from);
  const toDate = to === undefined ? undefined : toBusinessDate(to);

  // Opening balance: signed balance of all activity strictly before `from`.
  let openingBalance = 0n;
  if (fromDate !== undefined) {
    const openingRows = await db.$queryRawUnsafe<OpeningRawRow[]>(
      `SELECT COALESCE(SUM(jl.debit), 0)::bigint  AS d,
              COALESCE(SUM(jl.credit), 0)::bigint AS c
       FROM "${schema}".journal_lines jl
       JOIN "${schema}".journal_entries je ON je.id = jl."entryId"
       WHERE jl."accountId" = $1 AND je."entryDate" < $2`,
      account.id,
      fromDate,
    );
    const opening = openingRows[0];
    if (opening !== undefined) {
      openingBalance =
        account.normalBalance === "DEBIT" ? opening.d - opening.c : opening.c - opening.d;
    }
  }

  const dateFilter: { gte?: Date; lte?: Date } = {};
  if (fromDate !== undefined) {
    dateFilter.gte = fromDate;
  }
  if (toDate !== undefined) {
    dateFilter.lte = toDate;
  }

  const inRangeLines = await db.journalLine.findMany({
    where: {
      accountId: account.id,
      ...(fromDate !== undefined || toDate !== undefined
        ? { entry: { entryDate: dateFilter } }
        : {}),
    },
    include: { entry: true },
    orderBy: [
      { entry: { entryDate: "asc" } },
      { entry: { entryNumber: "asc" } },
      { lineNumber: "asc" },
    ],
  });

  // Compute running balances across the whole ordered range, then slice the
  // requested page so the running balance is correct even when paginated.
  let running = openingBalance;
  const allRows: AccountLedgerRow[] = inRangeLines.map((line) => {
    const delta =
      account.normalBalance === "DEBIT"
        ? line.debit - line.credit
        : line.credit - line.debit;
    running += delta;
    return {
      entryId: line.entryId,
      entryNumber: line.entry.entryNumber,
      entryDate: line.entry.entryDate,
      lineNumber: line.lineNumber,
      description: line.entry.description,
      source: line.entry.source,
      status: line.entry.status,
      debit: line.debit,
      credit: line.credit,
      runningBalance: running,
    };
  });

  const pageRows = allRows.slice(clampedSkip, clampedSkip + clampedTake);

  return {
    account: {
      code: account.code,
      name: account.name,
      accountClass: account.accountClass,
      normalBalance: account.normalBalance,
    },
    openingBalance,
    closingBalance: running,
    rows: pageRows,
    pagination: { take: clampedTake, skip: clampedSkip, total: allRows.length },
  };
}

/**
 * Close an accounting period.
 *
 * BUSINESS-TIME INTEGRITY GUARD (Task OFF.1). A period will NOT close while any
 * registered device could still deliver sales dated inside it. Closing over the
 * top of known-missing sales would FALSIFY the period rather than merely delay it:
 * the books would assert a complete month while a till sits in a shop with sales
 * from that month still in its outbox.
 *
 * The exact rule — and in particular why a LIVE lease blocks the close while an
 * ENDED or EXPIRED one does not — is documented on
 * findDevicesBlockingPeriodClose in src/services/offline/custody.ts. In short: a
 * live lease means the server does not know whether sales exist; an expired one
 * has already FROZEN the device's stock and raised it for a decision, so what it
 * may be carrying is known and flagged rather than unknown, and anything that does
 * arrive later takes the closed-period fallback with its true business date
 * recorded.
 *
 * The check and the close run in ONE transaction, so a device cannot take custody
 * in the gap between them.
 */
export async function closePeriod(
  db: TenantPrismaClient,
  year: number,
  month: number,
  userId: string,
): Promise<AccountingPeriodResult> {
  const schema = resolveSchema(db);
  const now = new Date();

  return db.$transaction(async (tx) => {
    const blocking = await findDevicesBlockingPeriodClose(tx, schema, year, month, now);
    if (blocking.length > 0) {
      const detail = blocking
        .map((device) => {
          const expiry =
            device.leaseExpiresAt === null
              ? "a lease that never expires"
              : `a lease until ${device.leaseExpiresAt.toISOString()}`;
          const synced =
            device.lastSyncAt === null
              ? "and has never synced"
              : `and last synced ${device.lastSyncAt.toISOString()}`;
          return `${device.deviceName} (${device.locationCode}) holds ${expiry} ${synced}`;
        })
        .join("; ");
      throw new PeriodCloseBlockedError(
        `Accounting period ${year}-${String(month).padStart(2, "0")} cannot be closed: ${blocking.length.toString()} device(s) could still deliver sales dated within it — ${detail}. Have each device sync, or end its lease, then close. Closing now would assert a complete period over sales the server knows may exist.`,
        blocking,
      );
    }

    const period = await tx.accountingPeriod.upsert({
      where: { year_month: { year, month } },
      update: { status: "CLOSED", closedAt: now, closedBy: userId },
      create: { year, month, status: "CLOSED", closedAt: now, closedBy: userId },
    });
    return {
      id: period.id,
      year: period.year,
      month: period.month,
      status: period.status,
      closedAt: period.closedAt,
      closedBy: period.closedBy,
    };
  });
}

export async function reopenPeriod(
  db: TenantPrismaClient,
  year: number,
  month: number,
  _userId: string,
): Promise<AccountingPeriodResult> {
  // The reopen is authorised to MSME_OWNER only at the route layer, which also
  // logs it. Here we simply clear the closed state.
  const period = await db.accountingPeriod.upsert({
    where: { year_month: { year, month } },
    update: { status: "OPEN", closedAt: null, closedBy: null },
    create: { year, month, status: "OPEN" },
  });
  return {
    id: period.id,
    year: period.year,
    month: period.month,
    status: period.status,
    closedAt: period.closedAt,
    closedBy: period.closedBy,
  };
}
