// ===========================================================================
// MENTORING RECORDS (Module 14, Task 14.2) — goals, agreed indicators, action items
// and coaching sessions, plus the LIVE computation of an indicator's actual.
//
// Task 14.3 adds the ENTREPRENEUR'S ONE WRITE (`completeOwnActionItem`: an MSME_OWNER
// marks an item assigned to the ENTREPRENEUR on their own business DONE) and exports the
// KPI computation the dashboard and cohort reuse — still the only writer, still no new math.
//
// THIS IS THE ONLY MODULE PERMITTED TO WRITE `mentorship_goals`,
// `mentorship_indicators`, `mentorship_action_items` or `mentorship_sessions`. Every
// one of them is a PLATFORM table about the mentoring RELATIONSHIP: nothing here
// writes, or opens for writing, the mentee's tenant schema.
//
// SCOPE IS THE ACTING MENTOR'S OWN ENGAGEMENT, AND IT FAILS AS 404. An engagement — or a
// record on one — that is not this mentor's is "not found", never "forbidden", exactly
// as in engagements.ts, so probing ids reveals nothing. The engagement and the mentor
// come from the record and the verified session; nothing in a request body is trusted
// beyond being checked against them.
//
// WRITES REQUIRE AN ACTIVE ENGAGEMENT (409 otherwise). The engagement row is share-
// locked for the length of each write, so an engagement cannot END between the check
// and the insert; platform migration 20261011170000's guard trigger refuses the write
// anyway if it somehow did. READS work on any status: an ENDED engagement's records are
// READ-ONLY HISTORY, not deleted history.
//
// AN INDICATOR'S ACTUAL IS NEVER STORED. `computeIndicatorActual` goes through the 14.1
// access gate (`withEngagedTenant` — ACTIVE engagement only, logged, READ ONLY) and
// takes every figure from the Module 13 engine, so the number is the one the owner's
// own report shows. The basis is the CURRENT MONTH TO DATE (`resolvePeriod({})`) for
// flows and its last day (today) for balances. The only arithmetic added here turns two
// of those report figures into a ratio: BigInt, rounded ONCE to 2 decimal places
// through `roundHalfUp`; a zero denominator yields no actual and says why.
// ===========================================================================

import { platformDb } from "../../db/platform";
import type {
  ActionItemStatus,
  ActionParty,
  GoalStatus,
  IndicatorSourceKey,
} from "../../generated/platform/enums";
import { businessToday } from "../../lib/business-time";
import { roundHalfUp, type Cents } from "../../lib/money";
import { CASH_ACCOUNTS } from "../report-classification";
import {
  buildBalanceSheet,
  buildIncomeStatement,
  resolvePeriod,
  type BalanceSheet,
  type Period,
  type ReportSource,
} from "../reports";
import { withEngagedTenant } from "./access";
import {
  isMentorRole,
  MentorshipNotFoundError,
  MentorshipStateError,
  MentorshipValidationError,
  type MentorshipActor,
} from "./engagements";

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Indicator kinds
// ---------------------------------------------------------------------------

/** Money KPIs: target and actual in KES cents. */
const AMOUNT_KEYS: ReadonlySet<IndicatorSourceKey> = new Set([
  "MONTHLY_REVENUE",
  "NET_PROFIT",
  "CASH_POSITION",
  "RECEIVABLES_OUTSTANDING",
]);

/** The only KPIs whose target may be negative (a smaller loss; a managed contraction). */
const SIGNED_TARGET_KEYS: ReadonlySet<IndicatorSourceKey> = new Set(["NET_PROFIT", "SALES_GROWTH_PCT"]);

export type IndicatorKind = "AMOUNT" | "RATE";

export function indicatorKindOf(key: IndicatorSourceKey): IndicatorKind {
  return AMOUNT_KEYS.has(key) ? "AMOUNT" : "RATE";
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface GoalRow {
  id: string;
  engagementId: string;
  title: string;
  description: string | null;
  targetValue: Cents | null;
  targetMetric: string | null;
  targetDate: Date | null;
  status: GoalStatus;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IndicatorRow {
  id: string;
  engagementId: string;
  name: string;
  sourceKey: IndicatorSourceKey;
  kind: IndicatorKind;
  targetAmount: Cents | null;
  /** A decimal string with 2 places, e.g. "35.00". */
  targetRate: string | null;
  note: string | null;
  createdById: string;
  createdAt: Date;
}

export interface ActionItemRow {
  id: string;
  engagementId: string;
  title: string;
  description: string | null;
  responsibleParty: ActionParty;
  dueDate: Date | null;
  status: ActionItemStatus;
  completedAt: Date | null;
  /** Who marked it DONE; null on a pre-14.3 completion (only the mentor could then). */
  completedById: string | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionRow {
  id: string;
  engagementId: string;
  sessionDate: Date;
  summary: string;
  observations: string | null;
  commitments: string | null;
  createdById: string;
  createdAt: Date;
}

export interface IndicatorActual {
  indicatorId: string;
  engagementId: string;
  businessName: string;
  name: string;
  sourceKey: IndicatorSourceKey;
  kind: IndicatorKind;
  /** The month to date the flows cover; balances are as at `period.to`. */
  period: Period;
  targetAmount: Cents | null;
  targetRate: string | null;
  /** AMOUNT indicators: the actual in cents (null only for a RATE indicator). */
  actualAmount: Cents | null;
  /** RATE indicators: the actual as a 2-place decimal string, or null when undefined. */
  actualRate: string | null;
  /** Why a RATE actual is null (a zero denominator), else null. */
  unavailableReason: string | null;
  computedAt: Date;
}

export interface IndicatorRecord {
  id: string;
  engagementId: string;
  name: string;
  sourceKey: IndicatorSourceKey;
  targetAmount: bigint | null;
  targetRate: { toFixed(places: number): string } | null;
  note: string | null;
  createdById: string;
  createdAt: Date;
}

export function toIndicatorRow(r: IndicatorRecord): IndicatorRow {
  return {
    id: r.id,
    engagementId: r.engagementId,
    name: r.name,
    sourceKey: r.sourceKey,
    kind: indicatorKindOf(r.sourceKey),
    targetAmount: r.targetAmount,
    targetRate: r.targetRate === null ? null : r.targetRate.toFixed(2),
    note: r.note,
    createdById: r.createdById,
    createdAt: r.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Scope: the acting mentor's own engagement
// ---------------------------------------------------------------------------

type PlatformTx = Parameters<Parameters<typeof platformDb.$transaction>[0]>[0];

function requireMentor(actor: MentorshipActor): void {
  if (!isMentorRole(actor.role)) {
    throw new MentorshipNotFoundError();
  }
}

/** READ scope: this mentor's engagement, any status. 404 otherwise. */
async function assertOwnEngagement(actor: MentorshipActor, engagementId: string): Promise<void> {
  requireMentor(actor);
  const found = await platformDb.mentorshipEngagement.findFirst({
    where: { id: engagementId, mentorId: actor.userId },
    select: { id: true },
  });
  if (found === null) {
    throw new MentorshipNotFoundError();
  }
}

/**
 * WRITE scope: inside `tx`, share-lock this mentor's engagement and require it ACTIVE.
 * 404 if it is not theirs; 409 if it is not ACTIVE (ENDED records are read-only history;
 * an INVITED engagement has not been consented to).
 */
async function lockActiveOwnEngagement(tx: PlatformTx, actor: MentorshipActor, engagementId: string): Promise<void> {
  requireMentor(actor);
  const rows = await tx.$queryRaw<Array<{ status: string }>>`
    SELECT "status"::text AS status
      FROM public."mentorship_engagements"
     WHERE "id" = ${engagementId} AND "mentorId" = ${actor.userId}
       FOR SHARE`;
  const row = rows[0];
  if (row === undefined) {
    throw new MentorshipNotFoundError();
  }
  if (row.status !== "ACTIVE") {
    throw new MentorshipStateError(
      `This engagement is ${row.status}; mentoring records can be written only while it is ACTIVE${
        row.status === "ENDED" ? " — an ended engagement's records are read-only history" : ""
      }.`,
    );
  }
}

function requireText(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new MentorshipValidationError(`${field} must not be blank.`);
  }
  return trimmed;
}

function optionalText(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

const TERMINAL_GOAL: ReadonlySet<GoalStatus> = new Set(["MET", "MISSED"]);

export interface CreateGoalInput {
  title: string;
  description?: string | null;
  targetValue?: Cents | null;
  targetMetric?: string | null;
  targetDate?: Date | null;
}

export async function createGoal(actor: MentorshipActor, engagementId: string, input: CreateGoalInput): Promise<GoalRow> {
  const title = requireText(input.title, "title");
  return platformDb.$transaction(async (tx) => {
    await lockActiveOwnEngagement(tx, actor, engagementId);
    return tx.goal.create({
      data: {
        engagementId,
        title,
        description: optionalText(input.description) ?? null,
        targetValue: input.targetValue ?? null,
        targetMetric: optionalText(input.targetMetric) ?? null,
        targetDate: input.targetDate ?? null,
        createdById: actor.userId,
      },
    });
  });
}

export async function listGoals(actor: MentorshipActor, engagementId: string): Promise<GoalRow[]> {
  await assertOwnEngagement(actor, engagementId);
  return platformDb.goal.findMany({ where: { engagementId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
}

export interface UpdateGoalInput {
  title?: string;
  description?: string | null;
  targetValue?: Cents | null;
  targetMetric?: string | null;
  targetDate?: Date | null;
  status?: GoalStatus;
}

export async function updateGoal(actor: MentorshipActor, goalId: string, input: UpdateGoalInput): Promise<GoalRow> {
  requireMentor(actor);
  return platformDb.$transaction(async (tx) => {
    const goal = await tx.goal.findFirst({
      where: { id: goalId, engagement: { mentorId: actor.userId } },
    });
    if (goal === null) {
      throw new MentorshipNotFoundError("No such goal.");
    }
    await lockActiveOwnEngagement(tx, actor, goal.engagementId);
    if (TERMINAL_GOAL.has(goal.status)) {
      throw new MentorshipStateError(`This goal is ${goal.status}, which is final; it cannot be changed.`);
    }
    return tx.goal.update({
      where: { id: goal.id },
      data: {
        title: input.title === undefined ? undefined : requireText(input.title, "title"),
        description: optionalText(input.description),
        targetValue: input.targetValue,
        targetMetric: optionalText(input.targetMetric),
        targetDate: input.targetDate,
        status: input.status,
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Indicators (targets only — the actual is computed live, below)
// ---------------------------------------------------------------------------

export interface CreateIndicatorInput {
  name: string;
  sourceKey: IndicatorSourceKey;
  targetAmount?: Cents | null;
  /** A decimal string with at most 2 places, e.g. "35.00". */
  targetRate?: string | null;
  note?: string | null;
}

export async function createIndicator(
  actor: MentorshipActor,
  engagementId: string,
  input: CreateIndicatorInput,
): Promise<IndicatorRow> {
  const name = requireText(input.name, "name");
  const kind = indicatorKindOf(input.sourceKey);
  const amount = input.targetAmount ?? null;
  const rate = input.targetRate ?? null;
  if (kind === "AMOUNT") {
    if (amount === null || rate !== null) {
      throw new MentorshipValidationError(
        `${input.sourceKey} is a money indicator: give targetAmount (KES) and no targetRate.`,
      );
    }
    if (amount < 0n && !SIGNED_TARGET_KEYS.has(input.sourceKey)) {
      throw new MentorshipValidationError(`A ${input.sourceKey} target must not be negative.`);
    }
  } else {
    if (rate === null || amount !== null) {
      throw new MentorshipValidationError(
        `${input.sourceKey} is a ratio indicator: give targetRate (a decimal string) and no targetAmount.`,
      );
    }
    if (rate.startsWith("-") && !SIGNED_TARGET_KEYS.has(input.sourceKey)) {
      throw new MentorshipValidationError(`A ${input.sourceKey} target must not be negative.`);
    }
  }
  return platformDb.$transaction(async (tx) => {
    await lockActiveOwnEngagement(tx, actor, engagementId);
    const created = await tx.performanceIndicator.create({
      data: {
        engagementId,
        name,
        sourceKey: input.sourceKey,
        targetAmount: amount,
        targetRate: rate,
        note: optionalText(input.note) ?? null,
        createdById: actor.userId,
      },
    });
    return toIndicatorRow(created);
  });
}

export async function listIndicators(actor: MentorshipActor, engagementId: string): Promise<IndicatorRow[]> {
  await assertOwnEngagement(actor, engagementId);
  const rows = await platformDb.performanceIndicator.findMany({
    where: { engagementId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(toIndicatorRow);
}

/** Render a value held in hundredths as a 2-place decimal string (a RATE, never money). */
function formatHundredths(hundredths: bigint): string {
  const negative = hundredths < 0n;
  const digits = (negative ? -hundredths : hundredths).toString().padStart(3, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/** numerator / denominator × scale, in hundredths, rounded once. Null on a zero denominator. */
function ratioHundredths(numerator: bigint, denominator: bigint, scale: bigint): bigint | null {
  if (denominator === 0n) return null;
  return roundHalfUp(numerator * scale * 100n, denominator);
}

/** A balance-sheet line's amount by account code; an account not shown has a zero balance. */
function balanceOf(sheet: BalanceSheet, codes: ReadonlySet<string>): Cents {
  let total = 0n;
  for (const section of [sheet.assets.current, sheet.assets.nonCurrent]) {
    for (const line of section.lines) {
      if (line.code !== null && codes.has(line.code)) total += line.amount;
    }
  }
  return total;
}

export interface ComputedValue {
  amount: Cents | null;
  rate: string | null;
  unavailableReason: string | null;
}

/** "35.00" / "-2.50" (always 2 places, as stored and as computed) -> hundredths. */
function hundredthsOf(rate: string): bigint {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(rate);
  if (m === null || m[2] === undefined || m[3] === undefined) {
    throw new Error(`Not a 2-place rate: "${rate}".`);
  }
  const value = BigInt(m[2]) * 100n + BigInt(m[3]);
  return m[1] === "-" ? -value : value;
}

/** Lower is better only for receivables outstanding; every other KPI aims high. */
const LOWER_IS_BETTER: ReadonlySet<IndicatorSourceKey> = new Set(["RECEIVABLES_OUTSTANDING"]);

export type IndicatorStanding = "ON_TARGET" | "OFF_TARGET" | "UNAVAILABLE";

/** Where an actual stands against its target. A comparison, not a computation. */
export function standingOf(indicator: IndicatorRow, value: ComputedValue): IndicatorStanding {
  let actual: bigint;
  let target: bigint;
  if (indicator.kind === "AMOUNT") {
    if (value.amount === null || indicator.targetAmount === null) return "UNAVAILABLE";
    actual = value.amount;
    target = indicator.targetAmount;
  } else {
    if (value.rate === null || indicator.targetRate === null) return "UNAVAILABLE";
    actual = hundredthsOf(value.rate);
    target = hundredthsOf(indicator.targetRate);
  }
  const met = LOWER_IS_BETTER.has(indicator.sourceKey) ? actual <= target : actual >= target;
  return met ? "ON_TARGET" : "OFF_TARGET";
}

/**
 * ONE KPI from the Module 13 engine over `source` (an engaged schema opened by the
 * gate). The single computation behind an indicator's actual, the dashboard and the
 * cohort roll-up.
 */
export async function computeKpiValue(source: ReportSource, key: IndicatorSourceKey, period: Period): Promise<ComputedValue> {
  return computeFromReports(source, key, period);
}

async function computeFromReports(source: ReportSource, key: IndicatorSourceKey, period: Period): Promise<ComputedValue> {
  const amount = (value: Cents): ComputedValue => ({ amount: value, rate: null, unavailableReason: null });
  const rate = (value: bigint | null, reason: string): ComputedValue =>
    value === null
      ? { amount: null, rate: null, unavailableReason: reason }
      : { amount: null, rate: formatHundredths(value), unavailableReason: null };

  switch (key) {
    case "MONTHLY_REVENUE":
      return amount((await buildIncomeStatement(source, period, false)).revenue.total);
    case "NET_PROFIT":
      return amount((await buildIncomeStatement(source, period, false)).netProfit.amount);
    case "CASH_POSITION":
      return amount(balanceOf(await buildBalanceSheet(source, period.to, false), CASH_ACCOUNTS));
    case "RECEIVABLES_OUTSTANDING":
      return amount(balanceOf(await buildBalanceSheet(source, period.to, false), new Set(["1100"])));
    case "GROSS_MARGIN_PCT": {
      const income = await buildIncomeStatement(source, period, false);
      return rate(
        ratioHundredths(income.grossProfit.amount, income.revenue.total, 100n),
        "No revenue in the period, so a gross margin is undefined.",
      );
    }
    case "SALES_GROWTH_PCT": {
      const income = await buildIncomeStatement(source, period, true);
      const prior = income.revenue.comparativeTotal ?? 0n;
      return rate(
        ratioHundredths(income.revenue.total - prior, prior, 100n),
        "No revenue in the comparative period, so growth against it is undefined.",
      );
    }
    case "INVENTORY_TURNOVER": {
      // COGS ÷ ((opening + closing inventory) ÷ 2) = 2·COGS ÷ (opening + closing).
      const income = await buildIncomeStatement(source, period, false);
      const dayBefore = new Date(period.from.getTime() - MS_PER_DAY);
      const opening = balanceOf(await buildBalanceSheet(source, dayBefore, false), new Set(["1200"]));
      const closing = balanceOf(await buildBalanceSheet(source, period.to, false), new Set(["1200"]));
      return rate(
        ratioHundredths(2n * income.costOfSales.total, opening + closing, 1n),
        "No inventory held at the start or end of the period, so turnover is undefined.",
      );
    }
  }
}

/**
 * The indicator's actual, computed NOW from the engaged business's books through the
 * access gate (ACTIVE engagement of this mentor only; logged; READ ONLY). Never stored.
 */
export async function computeIndicatorActual(actor: MentorshipActor, indicatorId: string): Promise<IndicatorActual> {
  requireMentor(actor);
  const record = await platformDb.performanceIndicator.findFirst({
    where: { id: indicatorId, engagement: { mentorId: actor.userId } },
  });
  if (record === null) {
    throw new MentorshipNotFoundError("No such indicator.");
  }
  const indicator = toIndicatorRow(record);
  return withEngagedTenant(actor.userId, indicator.engagementId, `indicator:${indicator.sourceKey}`, async (source, tenant) => {
    const period = resolvePeriod({});
    const value = await computeFromReports(source, indicator.sourceKey, period);
    return {
      indicatorId: indicator.id,
      engagementId: tenant.engagementId,
      businessName: tenant.businessName,
      name: indicator.name,
      sourceKey: indicator.sourceKey,
      kind: indicator.kind,
      period,
      targetAmount: indicator.targetAmount,
      targetRate: indicator.targetRate,
      actualAmount: value.amount,
      actualRate: value.rate,
      unavailableReason: value.unavailableReason,
      computedAt: new Date(),
    };
  });
}

// ---------------------------------------------------------------------------
// Action items
// ---------------------------------------------------------------------------

const TERMINAL_ACTION: ReadonlySet<ActionItemStatus> = new Set(["DONE", "CANCELLED"]);

export interface CreateActionItemInput {
  title: string;
  description?: string | null;
  responsibleParty: ActionParty;
  dueDate?: Date | null;
}

export async function createActionItem(
  actor: MentorshipActor,
  engagementId: string,
  input: CreateActionItemInput,
): Promise<ActionItemRow> {
  const title = requireText(input.title, "title");
  return platformDb.$transaction(async (tx) => {
    await lockActiveOwnEngagement(tx, actor, engagementId);
    return tx.actionItem.create({
      data: {
        engagementId,
        title,
        description: optionalText(input.description) ?? null,
        responsibleParty: input.responsibleParty,
        dueDate: input.dueDate ?? null,
        createdById: actor.userId,
      },
    });
  });
}

export async function listActionItems(actor: MentorshipActor, engagementId: string): Promise<ActionItemRow[]> {
  await assertOwnEngagement(actor, engagementId);
  return platformDb.actionItem.findMany({ where: { engagementId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
}

export interface UpdateActionItemInput {
  title?: string;
  description?: string | null;
  responsibleParty?: ActionParty;
  dueDate?: Date | null;
  status?: ActionItemStatus;
}

export async function updateActionItem(
  actor: MentorshipActor,
  actionItemId: string,
  input: UpdateActionItemInput,
): Promise<ActionItemRow> {
  requireMentor(actor);
  return platformDb.$transaction(async (tx) => {
    const item = await tx.actionItem.findFirst({
      where: { id: actionItemId, engagement: { mentorId: actor.userId } },
    });
    if (item === null) {
      throw new MentorshipNotFoundError("No such action item.");
    }
    await lockActiveOwnEngagement(tx, actor, item.engagementId);
    if (TERMINAL_ACTION.has(item.status)) {
      throw new MentorshipStateError(`This action item is ${item.status}, which is final; it cannot be changed.`);
    }
    return tx.actionItem.update({
      where: { id: item.id },
      data: {
        title: input.title === undefined ? undefined : requireText(input.title, "title"),
        description: optionalText(input.description),
        responsibleParty: input.responsibleParty,
        dueDate: input.dueDate,
        status: input.status,
        // DONE records when; the CHECK forbids any other status claiming a completion.
        completedAt: input.status === "DONE" ? new Date() : undefined,
        completedById: input.status === "DONE" ? actor.userId : undefined,
      },
    });
  });
}

/** The caller may see the record, but this write is not theirs to make. Route -> 403. */
export class MentorshipForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MentorshipForbiddenError";
  }
}

/**
 * THE ENTREPRENEUR'S ONE WRITE (Task 14.3). An MSME_OWNER marks an action item DONE —
 * only one on an engagement with THEIR OWN business (404 otherwise, as for any record
 * they may not see), only one assigned to the ENTREPRENEUR (403 for the mentor's own
 * items), only while the engagement is ACTIVE and the item OPEN (409). Nothing else
 * about the item changes. Platform tables only; the business's books are untouched.
 * The guard in platform migration 20261011190000 enforces every clause again.
 */
export async function completeOwnActionItem(actor: MentorshipActor, actionItemId: string): Promise<ActionItemRow> {
  if (actor.role !== "MSME_OWNER" || actor.tenantId === null) {
    throw new MentorshipNotFoundError("No such action item.");
  }
  const tenantId = actor.tenantId;
  return platformDb.$transaction(async (tx) => {
    const item = await tx.actionItem.findFirst({
      where: { id: actionItemId, engagement: { tenantId } },
    });
    if (item === null) {
      throw new MentorshipNotFoundError("No such action item.");
    }
    const rows = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT "status"::text AS status
        FROM public."mentorship_engagements"
       WHERE "id" = ${item.engagementId} AND "tenantId" = ${tenantId}
         FOR SHARE`;
    const engagementStatus = rows[0]?.status;
    if (engagementStatus === undefined) {
      throw new MentorshipNotFoundError("No such action item.");
    }
    if (item.responsibleParty !== "ENTREPRENEUR") {
      throw new MentorshipForbiddenError("This action item is the mentor's; you may complete only items assigned to the entrepreneur.");
    }
    if (engagementStatus !== "ACTIVE") {
      throw new MentorshipStateError(`This engagement is ${engagementStatus}; its action items are read-only history.`);
    }
    if (item.status !== "OPEN") {
      throw new MentorshipStateError(`This action item is ${item.status}, which is final.`);
    }
    return tx.actionItem.update({
      where: { id: item.id },
      data: { status: "DONE", completedAt: new Date(), completedById: actor.userId },
    });
  });
}

// ---------------------------------------------------------------------------
// Coaching sessions (immutable once recorded)
// ---------------------------------------------------------------------------

export interface CreateSessionInput {
  sessionDate: Date;
  summary: string;
  observations?: string | null;
  commitments?: string | null;
}

export async function createSession(
  actor: MentorshipActor,
  engagementId: string,
  input: CreateSessionInput,
): Promise<SessionRow> {
  const summary = requireText(input.summary, "summary");
  if (input.sessionDate.getTime() > businessToday().getTime()) {
    throw new MentorshipValidationError("sessionDate is in the future: a session is recorded after it has happened.");
  }
  return platformDb.$transaction(async (tx) => {
    await lockActiveOwnEngagement(tx, actor, engagementId);
    return tx.coachingSession.create({
      data: {
        engagementId,
        sessionDate: input.sessionDate,
        summary,
        observations: optionalText(input.observations) ?? null,
        commitments: optionalText(input.commitments) ?? null,
        createdById: actor.userId,
      },
    });
  });
}

export async function listSessions(actor: MentorshipActor, engagementId: string): Promise<SessionRow[]> {
  await assertOwnEngagement(actor, engagementId);
  return platformDb.coachingSession.findMany({
    where: { engagementId },
    orderBy: [{ sessionDate: "desc" }, { createdAt: "desc" }],
  });
}

export async function getSession(actor: MentorshipActor, sessionId: string): Promise<SessionRow> {
  requireMentor(actor);
  const session = await platformDb.coachingSession.findFirst({
    where: { id: sessionId, engagement: { mentorId: actor.userId } },
  });
  if (session === null) {
    throw new MentorshipNotFoundError("No such coaching session.");
  }
  return session;
}
