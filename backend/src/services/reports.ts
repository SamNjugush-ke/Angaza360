// ===========================================================================
// FINANCIAL STATEMENTS & REPORTING (Module 13).
//
// A PURE, READ-ONLY LAYER. This file writes NOTHING: no table, no journal entry, no
// row of any kind, and it imports no writer. Every figure is derived from posted
// journal lines and the chart of accounts through ONE balance query —
// `getTrialBalanceAsOf` in the ledger — so a statement can never compute a balance a
// different way than the ledger holds it.
//
// EVERY DATE IS A BUSINESS DATE. Balances are cumulative to an `asOf` by `entryDate`,
// and a period's movement is `balance(to) − balance(from − 1 day)`. `createdAt` is
// never consulted for any range (the engineering ledger "Timestamps & Reporting Dates"): a late-
// synced offline sale or a back-dated bill belongs to the day its entry is dated.
//
// SIGN CONVENTION. Internally every account carries `net = Σdebit − Σcredit`.
// Presentation flips credit-nature sections (liabilities, equity, revenue) so each
// section reads positive, and contra accounts (1590 accumulated depreciation, 3100
// drawings, 4900 returns) therefore present as NEGATIVE lines inside their section.
//
// EVERY STATEMENT ASSERTS ITS OWN IDENTITY and refuses to return a figure that fails
// it (`ReportIntegrityError`): the balance sheet balances, the cash flow ties to the
// cash accounts, the trial balance's debits equal its credits. A report that does not
// tie is a defect to surface, never a difference to absorb.
// ===========================================================================

import type { PrismaClient as TenantPrismaClient } from "../generated/tenant/client";
import type { AccountClass, TenantTaxRegime } from "../generated/tenant/enums";
import { assertValidSchemaName } from "../db/tenant";
import type { Cents } from "../lib/money";
import { businessToday } from "../lib/business-time";
import { getTrialBalanceAsOf, type LedgerReader } from "./ledger";
import { listOpenCreditSales } from "./receivables";
import {
  ACCUMULATED_DEPRECIATION,
  CASH_ACCOUNTS,
  cashFlowBucketOf,
  isIncomeStatementSection,
  sectionOf,
  type StatementSection,
} from "./report-classification";

/** A request the reports cannot answer as asked (from after to, half a period). Route -> 400. */
export class ReportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportValidationError";
  }
}

/** A statement failed its own identity. Never expected; surfaces as a 500, loudly. */
export class ReportIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportIntegrityError";
  }
}

// ---------------------------------------------------------------------------
// 1a. Periods
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/** A business-date range, both ends inclusive, each 00:00 UTC of its day. */
export interface Period {
  from: Date;
  to: Date;
}

function day(year: number, month: number, dayOfMonth: number): Date {
  return new Date(Date.UTC(year, month - 1, dayOfMonth));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

function lastDayOfMonth(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 0));
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface PeriodRequest {
  from?: Date;
  to?: Date;
  year?: number;
  month?: number;
}

/**
 * Resolve a period request. Exactly one shape is accepted:
 *   - `from` + `to`          a custom inclusive span;
 *   - `year` + `month`       that calendar month;
 *   - `year`                 that calendar year (the financial year — see below);
 *   - nothing                the current month to date.
 *
 * THE FINANCIAL YEAR IS THE CALENDAR YEAR (1 January). A configurable FY start is a
 * future plug on BusinessProfile; it is not added here, and every "year" in this file
 * means January to December.
 */
export function resolvePeriod(request: PeriodRequest, today: Date = businessToday()): Period {
  const hasRange = request.from !== undefined || request.to !== undefined;
  const hasCalendar = request.year !== undefined || request.month !== undefined;
  if (hasRange && hasCalendar) {
    throw new ReportValidationError("Give either from/to or year[/month], not both.");
  }
  if (hasRange) {
    if (request.from === undefined || request.to === undefined) {
      throw new ReportValidationError("A custom period needs both from and to.");
    }
    if (request.from > request.to) {
      throw new ReportValidationError(`from (${isoDay(request.from)}) is after to (${isoDay(request.to)}).`);
    }
    return { from: request.from, to: request.to };
  }
  if (request.month !== undefined) {
    if (request.year === undefined) {
      throw new ReportValidationError("month needs a year.");
    }
    return { from: day(request.year, request.month, 1), to: lastDayOfMonth(request.year, request.month) };
  }
  if (request.year !== undefined) {
    return { from: day(request.year, 1, 1), to: day(request.year, 12, 31) };
  }
  return { from: day(today.getUTCFullYear(), today.getUTCMonth() + 1, 1), to: today };
}

/**
 * THE COMPARATIVE PERIOD: the immediately preceding period of EQUAL length.
 *   - a whole calendar month  -> the previous whole month (lengths differ; months are the unit)
 *   - a whole calendar year   -> the previous year
 *   - any other span          -> the span of the same number of days ending the day before `from`
 */
export function comparativePeriodOf(period: Period): Period {
  const { from, to } = period;
  const fy = from.getUTCFullYear();
  const fm = from.getUTCMonth() + 1;
  const wholeMonth =
    from.getUTCDate() === 1 &&
    to.getTime() === lastDayOfMonth(fy, fm).getTime();
  const wholeYear =
    fm === 1 && from.getUTCDate() === 1 && to.getTime() === day(fy, 12, 31).getTime();
  if (wholeYear) {
    return { from: day(fy - 1, 1, 1), to: day(fy - 1, 12, 31) };
  }
  if (wholeMonth) {
    const py = fm === 1 ? fy - 1 : fy;
    const pm = fm === 1 ? 12 : fm - 1;
    return { from: day(py, pm, 1), to: lastDayOfMonth(py, pm) };
  }
  const lengthDays = Math.round((to.getTime() - from.getTime()) / MS_PER_DAY) + 1;
  return { from: addDays(from, -lengthDays), to: addDays(from, -1) };
}

/** The comparative point for an as-at report: the end of the month before `asOf`'s month. */
export function comparativeAsOfOf(asOf: Date): Date {
  return new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 0));
}

/** The first day of the financial (calendar) year containing `asOf`. */
export function financialYearStartOf(asOf: Date): Date {
  return day(asOf.getUTCFullYear(), 1, 1);
}

// ---------------------------------------------------------------------------
// 1b. The balance engine
// ---------------------------------------------------------------------------

export interface ReportSource {
  reader: LedgerReader;
  schema: string;
}

interface AccountFigures {
  code: string;
  name: string;
  accountClass: AccountClass;
  section: StatementSection;
  debit: Cents;
  credit: Cents;
  /** Σdebit − Σcredit. */
  net: Cents;
}

type Figures = Map<string, AccountFigures>;

/** Cumulative figures per account for every entry dated on or before `asOf`. */
async function balancesAsOf(source: ReportSource, asOf: Date): Promise<Figures> {
  const rows = await getTrialBalanceAsOf(source.reader, source.schema, asOf);
  const out: Figures = new Map();
  for (const row of rows) {
    out.set(row.code, {
      code: row.code,
      name: row.name,
      accountClass: row.accountClass,
      section: sectionOf(row.code, row.accountClass),
      debit: row.totalDebit,
      credit: row.totalCredit,
      net: row.totalDebit - row.totalCredit,
    });
  }
  return out;
}

/** Movement per account over an inclusive period: balance(to) − balance(from − 1 day). */
async function movementOver(source: ReportSource, period: Period): Promise<Figures> {
  const closing = await balancesAsOf(source, period.to);
  const opening = await balancesAsOf(source, addDays(period.from, -1));
  const out: Figures = new Map();
  for (const code of new Set([...closing.keys(), ...opening.keys()])) {
    const c = closing.get(code);
    const o = opening.get(code);
    const ref = c ?? o;
    if (ref === undefined) continue;
    const debit = (c?.debit ?? 0n) - (o?.debit ?? 0n);
    const credit = (c?.credit ?? 0n) - (o?.credit ?? 0n);
    out.set(code, { ...ref, debit, credit, net: debit - credit });
  }
  return out;
}

const CREDIT_NATURE: ReadonlySet<StatementSection> = new Set([
  "CURRENT_LIABILITY",
  "LONG_TERM_LIABILITY",
  "EQUITY",
  "REVENUE",
]);

/** The amount an account presents with in its section (credit-nature sections flipped). */
function presented(figures: AccountFigures | undefined): Cents {
  if (figures === undefined) return 0n;
  return CREDIT_NATURE.has(figures.section) ? -figures.net : figures.net;
}

/** Accumulated profit: −Σ net over every income-statement account (credit-positive). */
function profitOf(figures: Figures): Cents {
  let net = 0n;
  for (const f of figures.values()) {
    if (isIncomeStatementSection(f.section)) net += f.net;
  }
  return -net;
}

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export interface ReportLine {
  /** The account code, or null for a DERIVED line (e.g. current-year earnings). */
  code: string | null;
  name: string;
  amount: Cents;
  comparativeAmount: Cents | null;
}

export interface ReportSection {
  lines: ReportLine[];
  total: Cents;
  comparativeTotal: Cents | null;
}

export interface ReportFigure {
  amount: Cents;
  comparativeAmount: Cents | null;
}

function sumLines(lines: ReadonlyArray<ReportLine>): { total: Cents; comparativeTotal: Cents | null; anyComparative: boolean } {
  let total = 0n;
  let comparativeTotal = 0n;
  let anyComparative = false;
  for (const line of lines) {
    total += line.amount;
    if (line.comparativeAmount !== null) {
      anyComparative = true;
      comparativeTotal += line.comparativeAmount;
    }
  }
  return { total, comparativeTotal, anyComparative };
}

/** Build a section from every account in `sections`, current and comparative side by side. */
function sectionFrom(
  sections: ReadonlyArray<StatementSection>,
  current: Figures,
  comparative: Figures | null,
): ReportSection {
  const codes = new Set<string>();
  for (const f of current.values()) if (sections.includes(f.section)) codes.add(f.code);
  if (comparative !== null) {
    for (const f of comparative.values()) if (sections.includes(f.section)) codes.add(f.code);
  }
  const lines: ReportLine[] = [...codes]
    .sort()
    .map((code) => {
      const c = current.get(code);
      const p = comparative?.get(code);
      return {
        code,
        name: (c ?? p)?.name ?? code,
        amount: presented(c),
        comparativeAmount: comparative === null ? null : presented(p),
      };
    })
    .filter((line) => line.amount !== 0n || (line.comparativeAmount ?? 0n) !== 0n);
  const totals = sumLines(lines);
  return {
    lines,
    total: totals.total,
    comparativeTotal: comparative === null ? null : totals.comparativeTotal,
  };
}

function figure(amount: Cents, comparativeAmount: Cents | null): ReportFigure {
  return { amount, comparativeAmount };
}

// ---------------------------------------------------------------------------
// 2a. Income statement
// ---------------------------------------------------------------------------

export interface IncomeStatement {
  period: Period;
  comparativePeriod: Period | null;
  revenue: ReportSection;
  costOfSales: ReportSection;
  grossProfit: ReportFigure;
  operatingExpenses: ReportSection;
  netProfit: ReportFigure;
}

/**
 * Revenue (net of 4900 returns) − Cost of Sales = Gross Profit; − Operating Expenses
 * = Net Profit. Movements over the period by `entryDate`.
 */
export async function buildIncomeStatement(
  source: ReportSource,
  period: Period,
  withComparative: boolean,
): Promise<IncomeStatement> {
  const comparativePeriod = withComparative ? comparativePeriodOf(period) : null;
  const current = await movementOver(source, period);
  const prior = comparativePeriod === null ? null : await movementOver(source, comparativePeriod);

  const revenue = sectionFrom(["REVENUE"], current, prior);
  const costOfSales = sectionFrom(["COST_OF_SALES"], current, prior);
  const operatingExpenses = sectionFrom(["OPERATING_EXPENSE"], current, prior);

  const gross = revenue.total - costOfSales.total;
  const net = gross - operatingExpenses.total;
  const priorGross =
    prior === null ? null : (revenue.comparativeTotal ?? 0n) - (costOfSales.comparativeTotal ?? 0n);
  const priorNet = priorGross === null ? null : priorGross - (operatingExpenses.comparativeTotal ?? 0n);

  // The statement's own identity: net profit is −Σ net over every P&L account.
  if (net !== profitOf(current) || (prior !== null && priorNet !== profitOf(prior))) {
    throw new ReportIntegrityError(
      `Income statement does not tie: sections give ${net.toString()} but the P&L accounts net to ${profitOf(current).toString()}.`,
    );
  }

  return {
    period,
    comparativePeriod,
    revenue,
    costOfSales,
    grossProfit: figure(gross, priorGross),
    operatingExpenses,
    netProfit: figure(net, priorNet),
  };
}

// ---------------------------------------------------------------------------
// 2b. Balance sheet
// ---------------------------------------------------------------------------

export interface BalanceSheet {
  asOf: Date;
  comparativeAsOf: Date | null;
  financialYearStart: Date;
  assets: { current: ReportSection; nonCurrent: ReportSection; total: ReportFigure };
  liabilities: { current: ReportSection; longTerm: ReportSection; total: ReportFigure };
  equity: ReportSection;
  liabilitiesAndEquity: ReportFigure;
  /** Assets == Liabilities + Equity, to the cent, on both columns. Always true when returned. */
  balances: true;
}

interface EquityParts {
  accumulated: Cents;
  priorYears: Cents;
  currentYear: Cents;
}

async function equityPartsAsOf(source: ReportSource, asOf: Date, balances: Figures): Promise<EquityParts> {
  const accumulated = profitOf(balances);
  const priorYearEnd = addDays(financialYearStartOf(asOf), -1);
  const priorYears = profitOf(await balancesAsOf(source, priorYearEnd));
  return { accumulated, priorYears, currentYear: accumulated - priorYears };
}

/**
 * ASSETS = LIABILITIES + EQUITY, asserted to the cent.
 *
 * THERE ARE NO CLOSING ENTRIES (deferred), so profit never moves into 3200 by itself.
 * Equity is therefore Capital − Drawings + Retained Earnings (as posted) PLUS the
 * ACCUMULATED NET INCOME — every revenue, cost-of-sales and expense line ever posted up
 * to `asOf` — presented as "retained from prior financial years" and "current-year
 * earnings". Because every journal entry balances, Σ(asset nets) = −Σ(liability,
 * equity and P&L nets); moving the P&L total into equity is exactly what makes the
 * sheet balance. If it ever does not, the report fails rather than prints.
 */
export async function buildBalanceSheet(
  source: ReportSource,
  asOf: Date,
  withComparative: boolean,
): Promise<BalanceSheet> {
  const comparativeAsOf = withComparative ? comparativeAsOfOf(asOf) : null;
  const current = await balancesAsOf(source, asOf);
  const prior = comparativeAsOf === null ? null : await balancesAsOf(source, comparativeAsOf);
  const eq = await equityPartsAsOf(source, asOf, current);
  const priorEq = comparativeAsOf === null || prior === null ? null : await equityPartsAsOf(source, comparativeAsOf, prior);

  const currentAssets = sectionFrom(["CASH", "CURRENT_ASSET"], current, prior);
  const nonCurrentAssets = sectionFrom(["NON_CURRENT_ASSET"], current, prior);
  const currentLiabilities = sectionFrom(["CURRENT_LIABILITY"], current, prior);
  const longTermLiabilities = sectionFrom(["LONG_TERM_LIABILITY"], current, prior);
  const equityAccounts = sectionFrom(["EQUITY"], current, prior);

  const equityLines: ReportLine[] = [
    ...equityAccounts.lines,
    {
      code: null,
      name: "Retained earnings — prior financial years (accumulated, no closing entries)",
      amount: eq.priorYears,
      comparativeAmount: priorEq?.priorYears ?? null,
    },
    {
      code: null,
      name: "Current-year earnings",
      amount: eq.currentYear,
      comparativeAmount: priorEq?.currentYear ?? null,
    },
  ];
  const equityTotals = sumLines(equityLines);
  const equity: ReportSection = {
    lines: equityLines,
    total: equityTotals.total,
    comparativeTotal: prior === null ? null : equityTotals.comparativeTotal,
  };

  const assetsTotal = currentAssets.total + nonCurrentAssets.total;
  const liabilitiesTotal = currentLiabilities.total + longTermLiabilities.total;
  const lAndE = liabilitiesTotal + equity.total;
  const priorAssets =
    prior === null ? null : (currentAssets.comparativeTotal ?? 0n) + (nonCurrentAssets.comparativeTotal ?? 0n);
  const priorLiabilities =
    prior === null ? null : (currentLiabilities.comparativeTotal ?? 0n) + (longTermLiabilities.comparativeTotal ?? 0n);
  const priorLAndE = priorLiabilities === null ? null : priorLiabilities + (equity.comparativeTotal ?? 0n);

  if (assetsTotal !== lAndE) {
    throw new ReportIntegrityError(
      `Balance sheet as at ${isoDay(asOf)} does not balance: assets ${assetsTotal.toString()} vs liabilities + equity ${lAndE.toString()} (difference ${(assetsTotal - lAndE).toString()} cents). Refusing to report.`,
    );
  }
  if (priorAssets !== null && priorLAndE !== null && priorAssets !== priorLAndE) {
    throw new ReportIntegrityError(
      `Comparative balance sheet as at ${comparativeAsOf === null ? "?" : isoDay(comparativeAsOf)} does not balance: assets ${priorAssets.toString()} vs liabilities + equity ${priorLAndE.toString()}.`,
    );
  }

  return {
    asOf,
    comparativeAsOf,
    financialYearStart: financialYearStartOf(asOf),
    assets: {
      current: currentAssets,
      nonCurrent: nonCurrentAssets,
      total: figure(assetsTotal, priorAssets),
    },
    liabilities: {
      current: currentLiabilities,
      longTerm: longTermLiabilities,
      total: figure(liabilitiesTotal, priorLiabilities),
    },
    equity,
    liabilitiesAndEquity: figure(lAndE, priorLAndE),
    balances: true,
  };
}

// ---------------------------------------------------------------------------
// 2c. Cash flow (indirect)
// ---------------------------------------------------------------------------

export interface CashFlowColumn {
  netProfit: Cents;
  nonCashAdjustments: Cents;
  workingCapital: Cents;
  operating: Cents;
  investing: Cents;
  financing: Cents;
  netChangeInCash: Cents;
  openingCash: Cents;
  closingCash: Cents;
}

export interface CashFlowStatement {
  period: Period;
  comparativePeriod: Period | null;
  netProfit: ReportFigure;
  nonCashAdjustments: ReportSection;
  workingCapitalChanges: ReportSection;
  operatingActivities: ReportFigure;
  investingActivities: ReportSection;
  financingActivities: ReportSection;
  netChangeInCash: ReportFigure;
  openingCash: ReportFigure;
  closingCash: ReportFigure;
  /** Net change in cash == closing − opening cash & equivalents. Always true when returned. */
  tiesOut: true;
}

interface CashFlowParts {
  netProfit: Cents;
  byBucket: Map<string, Map<string, { name: string; amount: Cents }>>;
  openingCash: Cents;
  closingCash: Cents;
}

function cashOf(figures: Figures): Cents {
  let cash = 0n;
  for (const f of figures.values()) if (CASH_ACCOUNTS.has(f.code)) cash += f.net;
  return cash;
}

async function cashFlowParts(source: ReportSource, period: Period): Promise<CashFlowParts> {
  const movement = await movementOver(source, period);
  const byBucket = new Map<string, Map<string, { name: string; amount: Cents }>>();
  for (const f of movement.values()) {
    if (isIncomeStatementSection(f.section) || CASH_ACCOUNTS.has(f.code) || f.net === 0n) continue;
    const bucket = cashFlowBucketOf(f.code, f.section);
    const lines = byBucket.get(bucket) ?? new Map<string, { name: string; amount: Cents }>();
    // THE CASH EFFECT OF ANY NON-CASH BALANCE-SHEET MOVEMENT IS −(Σdebit − Σcredit):
    // an asset that grew absorbed cash, a liability or equity that grew supplied it.
    lines.set(f.code, { name: f.name, amount: -f.net });
    byBucket.set(bucket, lines);
  }
  const opening = await balancesAsOf(source, addDays(period.from, -1));
  const closing = await balancesAsOf(source, period.to);
  return { netProfit: profitOf(movement), byBucket, openingCash: cashOf(opening), closingCash: cashOf(closing) };
}

function bucketSection(
  bucket: string,
  current: CashFlowParts,
  prior: CashFlowParts | null,
  label: (code: string, name: string) => string,
): ReportSection {
  const cur = current.byBucket.get(bucket) ?? new Map<string, { name: string; amount: Cents }>();
  const pri = prior?.byBucket.get(bucket) ?? new Map<string, { name: string; amount: Cents }>();
  const lines: ReportLine[] = [...new Set([...cur.keys(), ...pri.keys()])].sort().map((code) => {
    const name = (cur.get(code) ?? pri.get(code))?.name ?? code;
    return {
      code,
      name: label(code, name),
      amount: cur.get(code)?.amount ?? 0n,
      comparativeAmount: prior === null ? null : (pri.get(code)?.amount ?? 0n),
    };
  });
  const totals = sumLines(lines);
  return { lines, total: totals.total, comparativeTotal: prior === null ? null : totals.comparativeTotal };
}

/**
 * INDIRECT METHOD. Operating = net profit + non-cash add-backs (the period movement of
 * 1590 accumulated depreciation) + working-capital changes; investing = the movement of
 * gross fixed assets; financing = loans, capital, drawings and any direct posting to
 * retained earnings.
 *
 * THE TIE-OUT IS AN IDENTITY, NOT A HOPE: every balance-sheet account outside the cash
 * set sits in exactly one bucket (report-classification.ts), every P&L account is in
 * net profit, and every entry balances — so the sum of the sections MUST equal the
 * movement of the cash accounts. It is asserted for both columns, and a break fails
 * the report.
 */
export async function buildCashFlow(
  source: ReportSource,
  period: Period,
  withComparative: boolean,
): Promise<CashFlowStatement> {
  const comparativePeriod = withComparative ? comparativePeriodOf(period) : null;
  const cur = await cashFlowParts(source, period);
  const pri = comparativePeriod === null ? null : await cashFlowParts(source, comparativePeriod);

  const nonCash = bucketSection("NON_CASH", cur, pri, (code, name) =>
    code === ACCUMULATED_DEPRECIATION ? `Depreciation (movement of ${code} ${name})` : `Non-cash: ${name}`,
  );
  const workingCapital = bucketSection("WORKING_CAPITAL", cur, pri, (_code, name) => `(Increase)/decrease in ${name}`);
  const investing = bucketSection("INVESTING", cur, pri, (_code, name) => `(Purchase)/disposal of ${name}`);
  const financing = bucketSection("FINANCING", cur, pri, (_code, name) => name);

  const column = (parts: CashFlowParts, which: "total" | "comparativeTotal"): CashFlowColumn => {
    const pick = (s: ReportSection): Cents => (which === "total" ? s.total : (s.comparativeTotal ?? 0n));
    const operating = parts.netProfit + pick(nonCash) + pick(workingCapital);
    const netChange = operating + pick(investing) + pick(financing);
    return {
      netProfit: parts.netProfit,
      nonCashAdjustments: pick(nonCash),
      workingCapital: pick(workingCapital),
      operating,
      investing: pick(investing),
      financing: pick(financing),
      netChangeInCash: netChange,
      openingCash: parts.openingCash,
      closingCash: parts.closingCash,
    };
  };
  const c = column(cur, "total");
  const p = pri === null ? null : column(pri, "comparativeTotal");

  for (const [label, col, per] of [["current", c, period], ["comparative", p, comparativePeriod]] as const) {
    if (col === null || per === null) continue;
    if (col.netChangeInCash !== col.closingCash - col.openingCash) {
      throw new ReportIntegrityError(
        `Cash flow (${label}, ${isoDay(per.from)}..${isoDay(per.to)}) does not tie: sections give ${col.netChangeInCash.toString()} but cash & equivalents moved ${(col.closingCash - col.openingCash).toString()} (opening ${col.openingCash.toString()}, closing ${col.closingCash.toString()}). Refusing to report.`,
      );
    }
  }

  return {
    period,
    comparativePeriod,
    netProfit: figure(c.netProfit, p?.netProfit ?? null),
    nonCashAdjustments: nonCash,
    workingCapitalChanges: workingCapital,
    operatingActivities: figure(c.operating, p?.operating ?? null),
    investingActivities: investing,
    financingActivities: financing,
    netChangeInCash: figure(c.netChangeInCash, p?.netChangeInCash ?? null),
    openingCash: figure(c.openingCash, p?.openingCash ?? null),
    closingCash: figure(c.closingCash, p?.closingCash ?? null),
    tiesOut: true,
  };
}

// ---------------------------------------------------------------------------
// 2d. Trial balance
// ---------------------------------------------------------------------------

export interface TrialBalanceReportRow {
  code: string;
  name: string;
  accountClass: AccountClass;
  section: StatementSection;
  debit: Cents;
  credit: Cents;
  comparativeDebit: Cents | null;
  comparativeCredit: Cents | null;
}

export interface TrialBalanceReport {
  asOf: Date;
  comparativeAsOf: Date | null;
  rows: TrialBalanceReportRow[];
  totals: { debit: Cents; credit: Cents; comparativeDebit: Cents | null; comparativeCredit: Cents | null };
  /** Σ debits == Σ credits on both columns. Always true when returned. */
  balanced: true;
}

/** Every account with its balance on the side it falls: debit if Σdr > Σcr, else credit. */
export async function buildTrialBalance(
  source: ReportSource,
  asOf: Date,
  withComparative: boolean,
): Promise<TrialBalanceReport> {
  const comparativeAsOf = withComparative ? comparativeAsOfOf(asOf) : null;
  const current = await balancesAsOf(source, asOf);
  const prior = comparativeAsOf === null ? null : await balancesAsOf(source, comparativeAsOf);
  const side = (f: AccountFigures | undefined): { debit: Cents; credit: Cents } => {
    const net = f?.net ?? 0n;
    return net >= 0n ? { debit: net, credit: 0n } : { debit: 0n, credit: -net };
  };
  const codes = [...new Set([...current.keys(), ...(prior?.keys() ?? [])])].sort();
  const rows: TrialBalanceReportRow[] = [];
  let debit = 0n;
  let credit = 0n;
  let pDebit = 0n;
  let pCredit = 0n;
  for (const code of codes) {
    const c = current.get(code);
    const p = prior?.get(code);
    const ref = c ?? p;
    if (ref === undefined) continue;
    const cs = side(c);
    const ps = prior === null ? null : side(p);
    if (cs.debit === 0n && cs.credit === 0n && (ps === null || (ps.debit === 0n && ps.credit === 0n))) continue;
    debit += cs.debit;
    credit += cs.credit;
    if (ps !== null) {
      pDebit += ps.debit;
      pCredit += ps.credit;
    }
    rows.push({
      code,
      name: ref.name,
      accountClass: ref.accountClass,
      section: ref.section,
      debit: cs.debit,
      credit: cs.credit,
      comparativeDebit: ps?.debit ?? null,
      comparativeCredit: ps?.credit ?? null,
    });
  }
  if (debit !== credit || (prior !== null && pDebit !== pCredit)) {
    throw new ReportIntegrityError(
      `Trial balance as at ${isoDay(asOf)} does not balance: debits ${debit.toString()} vs credits ${credit.toString()}.`,
    );
  }
  return {
    asOf,
    comparativeAsOf,
    rows,
    totals: {
      debit,
      credit,
      comparativeDebit: prior === null ? null : pDebit,
      comparativeCredit: prior === null ? null : pCredit,
    },
    balanced: true,
  };
}

// ---------------------------------------------------------------------------
// 3a. VAT return (and the TOT position)
// ---------------------------------------------------------------------------

const ACCT_VAT_OUTPUT = "2100";
const ACCT_VAT_INPUT = "1400";
const ACCT_TOT = "2110";

export interface VatReturn {
  period: Period;
  taxRegime: TenantTaxRegime;
  isVatRegistered: boolean;
  /** What this return primarily presents for the tenant's regime. */
  presentation: "VAT_RETURN" | "TOT_POSITION";
  vat: {
    outputVat: { charged: Cents; reversed: Cents; net: Cents };
    inputVat: { claimed: Cents; reversed: Cents; net: Cents };
    /** output.net − input.net: positive is payable to KRA, negative refundable. */
    netVat: Cents;
    position: "PAYABLE" | "REFUNDABLE" | "NIL";
    /**
     * SALES TURNOVER BY THE KRA CODE EACH LINE WAS CHARGED UNDER (Task 3B.1) — net
     * (VAT-exclusive) value, posted less voided in the period. A correct VAT3 return
     * needs all of them: standard-rated turnover and its VAT (ties to outputVat.net when
     * every 2100 movement came from a sale), zero-rated turnover, exempt turnover, and
     * non-VAT turnover (sales made while not VAT-registered). A pre-3B.1 line counts as
     * standard-rated, which is how it was charged.
     */
    salesByCode: {
      standardRated: { turnover: Cents; vat: Cents };
      zeroRated: { turnover: Cents };
      exempt: { turnover: Cents };
      nonVat: { turnover: Cents };
    };
    /** Net value of every purchase entry in the period that moved input VAT. */
    taxablePurchases: Cents;
  };
  /**
   * THE TURNOVER TAX POSITION (Task 3B.2) — a COMPUTED liability, tied three ways:
   * `accrued` (Σ Sale.totAccrued, posted less voided in the period) == the period's
   * 2110 movement (`ledgerMovement`), over `turnover` (the net sales that accrued it).
   */
  turnoverTax: {
    accountCode: string;
    /** The TOT rate in force at the period's end, or null if no schedule covers it. */
    ratePercent: string | null;
    turnover: Cents;
    accrued: Cents;
    ledgerMovement: Cents;
    closingBalance: Cents;
    /** accrued == ledgerMovement. */
    reconciles: boolean;
  };
  /** Explicit, named discrepancies between the regime and what the ledger carries. */
  anomalies: Array<{ code: string; message: string; amount: Cents }>;
}

interface RegimeRow {
  taxRegime: TenantTaxRegime;
  isVatRegistered: boolean;
}

/**
 * THE VAT RETURN (VAT-registered) or THE TOT POSITION (not registered) for a period,
 * plus whatever the ledger carries that the regime says it should not. Nothing is
 * hidden to make a regime look tidy: a TOT tenant whose till posted output VAT sees
 * that VAT as a named anomaly, because KRA will see the invoices even if the report
 * does not.
 *
 * All figures are NET period movements by `entryDate` — a voided sale's VAT reversal
 * reduces output VAT, a cancelled bill's reversal reduces input VAT — with the gross
 * components shown beside them.
 */
export async function buildVatReturn(source: ReportSource, period: Period): Promise<VatReturn> {
  const { reader, schema } = source;
  assertValidSchemaName(schema);
  const movement = await movementOver(source, period);
  const closing = await balancesAsOf(source, period.to);
  const regimeRows = await reader.$queryRawUnsafe<RegimeRow[]>(
    `SELECT "taxRegime", "isVatRegistered" FROM "${schema}".business_profile WHERE "id" = 'singleton'`,
  );
  const regime = regimeRows[0];
  if (regime === undefined) {
    throw new ReportIntegrityError("This tenant has no business profile, so its tax regime is unknown.");
  }

  const out = movement.get(ACCT_VAT_OUTPUT);
  const inp = movement.get(ACCT_VAT_INPUT);
  const outputVat = { charged: out?.credit ?? 0n, reversed: out?.debit ?? 0n, net: -(out?.net ?? 0n) };
  const inputVat = { claimed: inp?.debit ?? 0n, reversed: inp?.credit ?? 0n, net: inp?.net ?? 0n };
  const netVat = outputVat.net - inputVat.net;

  // SALES BY KRA CODE from the sale lines: posted in the period, less those whose void
  // was posted in the period — the same events that moved 2100. Grouped by the code
  // each line was CHARGED under (NULL on a pre-3B.1 line = B, as it was charged).
  const salesRows = await reader.$queryRawUnsafe<Array<{ code: string; base: bigint; vat: bigint }>>(
    `SELECT COALESCE(sl."taxCode"::text, 'B') AS code,
            (COALESCE(SUM(CASE WHEN posted."entryDate" BETWEEN $1 AND $2 THEN sl."lineNet" ELSE 0 END), 0)
           - COALESCE(SUM(CASE WHEN voided."entryDate" BETWEEN $1 AND $2 THEN sl."lineNet" ELSE 0 END), 0))::bigint AS base,
            (COALESCE(SUM(CASE WHEN posted."entryDate" BETWEEN $1 AND $2 THEN sl."lineVat" ELSE 0 END), 0)
           - COALESCE(SUM(CASE WHEN voided."entryDate" BETWEEN $1 AND $2 THEN sl."lineVat" ELSE 0 END), 0))::bigint AS vat
       FROM "${schema}".sale_lines sl
       JOIN "${schema}".sales s ON s."id" = sl."saleId"
       LEFT JOIN "${schema}".journal_entries posted ON posted."id" = s."saleJournalEntryId"
       LEFT JOIN "${schema}".journal_entries voided ON voided."id" = s."voidedByEntryId"
      GROUP BY 1`,
    period.from,
    period.to,
  );
  const byCode = (code: string): { base: Cents; vat: Cents } => {
    const row = salesRows.find((r) => r.code === code);
    return { base: row?.base ?? 0n, vat: row?.vat ?? 0n };
  };
  // Taxable PURCHASES from the ENTRY STRUCTURE, because an ad-hoc receipt records its
  // input VAT only in the GL: for each entry that moved 1400, the net purchase is what
  // it settled to the supplier (Cr 2000 or cash) less the VAT it recognised. A bill, an
  // ad-hoc receipt and a cancellation's reversal all fall out of the same rule.
  const purchaseRows = await reader.$queryRawUnsafe<Array<{ base: bigint }>>(
    `SELECT COALESCE(SUM(e.settled - e.vat), 0)::bigint AS base FROM (
       SELECT l."entryId",
              SUM(CASE WHEN a."code" = '${ACCT_VAT_INPUT}' THEN l."debit" - l."credit" ELSE 0 END) AS vat,
              SUM(CASE WHEN a."code" IN ('2000', '1000', '1010', '1020') THEN l."credit" - l."debit" ELSE 0 END) AS settled
         FROM "${schema}".journal_lines l
         JOIN "${schema}".accounts a ON a."id" = l."accountId"
         JOIN "${schema}".journal_entries je ON je."id" = l."entryId"
        WHERE je."entryDate" BETWEEN $1 AND $2
        GROUP BY l."entryId"
       HAVING SUM(CASE WHEN a."code" = '${ACCT_VAT_INPUT}' THEN l."debit" - l."credit" ELSE 0 END) <> 0
     ) e`,
    period.from,
    period.to,
  );

  const tot = movement.get(ACCT_TOT);
  const totClosing = closing.get(ACCT_TOT);

  // THE TOT ACCRUED BY SALES in the period — posted less voided, by the dates of the
  // sale entry and its reversal, the same events that moved 2110. Turnover is the net
  // value of the sales that accrued it.
  const totRows = await reader.$queryRawUnsafe<Array<{ turnover: bigint; accrued: bigint }>>(
    `SELECT (COALESCE(SUM(CASE WHEN posted."entryDate" BETWEEN $1 AND $2 THEN s."subtotal" ELSE 0 END), 0)
           - COALESCE(SUM(CASE WHEN voided."entryDate" BETWEEN $1 AND $2 THEN s."subtotal" ELSE 0 END), 0))::bigint AS turnover,
            (COALESCE(SUM(CASE WHEN posted."entryDate" BETWEEN $1 AND $2 THEN s."totAccrued" ELSE 0 END), 0)
           - COALESCE(SUM(CASE WHEN voided."entryDate" BETWEEN $1 AND $2 THEN s."totAccrued" ELSE 0 END), 0))::bigint AS accrued
       FROM "${schema}".sales s
       LEFT JOIN "${schema}".journal_entries posted ON posted."id" = s."saleJournalEntryId"
       LEFT JOIN "${schema}".journal_entries voided ON voided."id" = s."voidedByEntryId"
      WHERE s."totAccrued" > 0`,
    period.from,
    period.to,
  );
  const totRateRows = await reader.$queryRawUnsafe<Array<{ rate: string }>>(
    `SELECT "totRatePercent"::text AS rate FROM "${schema}".statutory_schedules
      WHERE "effectiveFrom" <= $1 AND ("effectiveTo" IS NULL OR "effectiveTo" > $1)`,
    period.to,
  );
  const totTurnover = totRows[0]?.turnover ?? 0n;
  const totAccrued = totRows[0]?.accrued ?? 0n;
  const totLedger = -(tot?.net ?? 0n);

  const anomalies: VatReturn["anomalies"] = [];
  if (!regime.isVatRegistered) {
    if (outputVat.net !== 0n) {
      anomalies.push({
        code: "VAT_OUTPUT_WHILE_NOT_REGISTERED",
        message: `Output VAT moved 2100 in this period although the tenant is ${regime.taxRegime}, not VAT-registered. Since Task 3B.1 a non-registered tenant's sales post NO VAT, so this is VAT charged before that fix (the POS used to charge it regardless of regime), a manual entry to 2100, or sales made while the tenant was registered.`,
        amount: outputVat.net,
      });
    }
    if (inputVat.net !== 0n) {
      anomalies.push({
        code: "VAT_INPUT_WHILE_NOT_REGISTERED",
        message: `Input VAT moved 1400 in this period although the tenant is ${regime.taxRegime}: a non-registered business cannot recover input VAT.`,
        amount: inputVat.net,
      });
    }
  }
  if (totAccrued !== totLedger) {
    anomalies.push({
      code: "TOT_LEDGER_MISMATCH",
      message: "2110 TOT Payable moved by something other than sales' Turnover Tax accruals and their voids (e.g. a manual entry, or a remittance once TOT settlement is built). The accrued figure covers sales only.",
      amount: totLedger - totAccrued,
    });
  }
  if (regime.taxRegime === "TURNOVER_TAX") {
    const untaxed = byCode("D").base - totTurnover;
    if (untaxed > 0n) {
      anomalies.push({
        code: "TOT_NOT_ACCRUED_BEFORE_3B2",
        message: "Non-VAT turnover in this period carries no Turnover Tax accrual: these are sales posted before TOT accrual existed (Task 3B.2 is forward-only). Back-accruing them is a business decision, not something this report does.",
        amount: untaxed,
      });
    }
  }
  const standard = byCode("B");
  if (standard.vat !== outputVat.net) {
    anomalies.push({
      code: "OUTPUT_VAT_NOT_FROM_SALES",
      message: "Output VAT moved by something other than sales and their voids (e.g. a manual entry to 2100); the standard-rated sales figure covers sales only.",
      amount: outputVat.net - standard.vat,
    });
  }

  return {
    period,
    taxRegime: regime.taxRegime,
    isVatRegistered: regime.isVatRegistered,
    presentation: regime.isVatRegistered ? "VAT_RETURN" : "TOT_POSITION",
    vat: {
      outputVat,
      inputVat,
      netVat,
      position: netVat > 0n ? "PAYABLE" : netVat < 0n ? "REFUNDABLE" : "NIL",
      salesByCode: {
        standardRated: { turnover: standard.base, vat: standard.vat },
        zeroRated: { turnover: byCode("C").base },
        exempt: { turnover: byCode("A").base },
        nonVat: { turnover: byCode("D").base },
      },
      taxablePurchases: purchaseRows[0]?.base ?? 0n,
    },
    turnoverTax: {
      accountCode: ACCT_TOT,
      ratePercent: totRateRows.length === 1 ? (totRateRows[0]?.rate ?? null) : null,
      turnover: totTurnover,
      accrued: totAccrued,
      ledgerMovement: totLedger,
      closingBalance: -(totClosing?.net ?? 0n),
      reconciles: totAccrued === totLedger,
    },
    anomalies,
  };
}

// ---------------------------------------------------------------------------
// 3b. Control-account reconciliation
// ---------------------------------------------------------------------------

export interface ControlReconciliationItem {
  control: "INVENTORY" | "ACCOUNTS_RECEIVABLE" | "ACCOUNTS_PAYABLE" | "GRNI";
  accountCode: string;
  glBalance: Cents;
  subledgerLabel: string;
  subledger: Cents;
  /** Known, structural reconciling lines — each named, never a hidden gap. */
  residuals: Array<{ label: string; amount: Cents }>;
  /** glBalance − subledger − Σ residuals. Must be 0. */
  unexplained: Cents;
  reconciles: boolean;
}

export interface ControlReconciliation {
  /** The subledgers are CURRENT-STATE projections, so the GL side covers every posted entry. */
  basis: "CURRENT";
  items: ControlReconciliationItem[];
  allReconcile: boolean;
}

// Far enough out to include every posted entry, including future-dated ones (a payroll
// accrual dated to its pay date) — because the subledgers include those documents too.
const ALL_POSTED = new Date(Date.UTC(9999, 11, 31));

function item(
  control: ControlReconciliationItem["control"],
  accountCode: string,
  glBalance: Cents,
  subledgerLabel: string,
  subledger: Cents,
  residuals: Array<{ label: string; amount: Cents }>,
): ControlReconciliationItem {
  const unexplained = glBalance - subledger - residuals.reduce((s, r) => s + r.amount, 0n);
  return { control, accountCode, glBalance, subledgerLabel, subledger, residuals, unexplained, reconciles: unexplained === 0n };
}

async function scalar(reader: LedgerReader, sql: string): Promise<Cents> {
  const rows = await reader.$queryRawUnsafe<Array<{ v: bigint | null }>>(sql);
  return rows[0]?.v ?? 0n;
}

/**
 * Ties each subledger to its GL control account. CURRENT POSITION ONLY: the subledger
 * figures (`Product.stockValue`, open credit sales, unpaid bills, GRNI by PO line) are
 * current-state projections with no as-at history, so comparing them with a back-dated
 * GL balance would manufacture a difference. The known structural residuals are named
 * lines (the engineering ledger "Accounts Receivable" and "Accounts Payable"):
 *
 *   AR   GL(1100) = open credit sales + AR raised by failed/timed-out M-Pesa STK pushes
 *   AP   GL(2000) = unpaid bills      + ad-hoc purchase receipts booked on account
 */
export async function buildControlReconciliation(
  db: TenantPrismaClient,
  schema: string,
): Promise<ControlReconciliation> {
  assertValidSchemaName(schema);
  const balances = await balancesAsOf({ reader: db, schema }, ALL_POSTED);
  const gl = (code: string, creditNature: boolean): Cents => {
    const net = balances.get(code)?.net ?? 0n;
    return creditNature ? -net : net;
  };

  // Inventory.
  const stockValue = await scalar(db, `SELECT COALESCE(SUM("stockValue"), 0)::bigint AS v FROM "${schema}".products`);

  // Accounts receivable.
  const open = await listOpenCreditSales(db);
  const arSubledger = open.reduce((s, row) => s + row.outstanding, 0n);
  const mpesaResidual = await scalar(
    db,
    `SELECT COALESCE(SUM(l."debit" - l."credit"), 0)::bigint AS v
       FROM "${schema}".mpesa_transactions m
       JOIN "${schema}".journal_lines l ON l."entryId" = m."reversalEntryId"
       JOIN "${schema}".accounts a ON a."id" = l."accountId"
      WHERE a."code" = '1100'`,
  );

  // Accounts payable.
  const apSubledger = await scalar(
    db,
    `SELECT COALESCE(SUM("total" - "amountPaid"), 0)::bigint AS v
       FROM "${schema}".supplier_bills WHERE "status" IN ('AWAITING_PAYMENT', 'PARTIALLY_PAID')`,
  );
  const adHocResidual = await scalar(
    db,
    `SELECT COALESCE(SUM(l."credit" - l."debit"), 0)::bigint AS v
       FROM "${schema}".stock_movements sm
       JOIN "${schema}".journal_lines l ON l."entryId" = sm."journalEntryId"
       JOIN "${schema}".accounts a ON a."id" = l."accountId"
      WHERE sm."movementType" = 'PURCHASE_RECEIPT' AND sm."goodsReceiptId" IS NULL AND a."code" = '2000'`,
  );

  // GRNI: accrued by receipts (their totalCost IS what each credited to 2050) less
  // cleared by live bills.
  const grniAccrued = await scalar(
    db,
    `SELECT COALESCE(SUM("totalCost"), 0)::bigint AS v FROM "${schema}".stock_movements WHERE "goodsReceiptId" IS NOT NULL`,
  );
  const grniCleared = await scalar(
    db,
    `SELECT COALESCE(SUM(bl."grniCleared"), 0)::bigint AS v
       FROM "${schema}".supplier_bill_lines bl
       JOIN "${schema}".supplier_bills b ON b."id" = bl."billId"
      WHERE b."status" NOT IN ('DRAFT', 'CANCELLED')`,
  );

  const items = [
    item("INVENTORY", "1200", gl("1200", false), "Σ Product.stockValue", stockValue, []),
    item("ACCOUNTS_RECEIVABLE", "1100", gl("1100", false), "Σ outstanding on open credit sales", arSubledger, [
      { label: "AR raised by failed / timed-out M-Pesa STK pushes (no customer attribution)", amount: mpesaResidual },
    ]),
    item("ACCOUNTS_PAYABLE", "2000", gl("2000", true), "Σ unpaid balances of posted supplier bills", apSubledger, [
      { label: "Ad-hoc purchase receipts booked on account (no supplier bill behind them)", amount: adHocResidual },
    ]),
    item("GRNI", "2050", gl("2050", true), "Received not yet billed (accrued by receipts − cleared by live bills)", grniAccrued - grniCleared, []),
  ];
  return { basis: "CURRENT", items, allReconcile: items.every((i) => i.reconciles) };
}
