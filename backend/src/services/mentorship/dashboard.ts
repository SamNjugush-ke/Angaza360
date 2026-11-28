// ===========================================================================
// MENTORSHIP VIEWS (Module 14, Task 14.3) — the composed mentor dashboard, the mentor's
// cohort roll-up, and the entrepreneur's RECIPROCAL view of their own mentoring.
//
// THIS MODULE WRITES NOTHING. It assembles what 14.1 and 14.2 already hold: the
// engagement, the agreed indicators with their LIVE actuals, goals, action items and
// sessions. Its only reads of a business's books go through 14.1's gate
// (`withEngagedTenant` — ACTIVE engagement of this mentor only, logged, READ ONLY), and
// every figure comes from the same `computeKpiValue` an indicator's actual uses, i.e.
// from the Module 13 engine. There is no second computation to disagree with.
//
//   * DASHBOARD — ONE gate opening per view, so every actual on the page is read from
//     one consistent READ ONLY snapshot and the owner's access log shows one read naming
//     the indicators it covered.
//   * COHORT — the sanctioned cross-tenant roll-up: the mentor's ACTIVE engagements, each
//     mentee resolved through ITS OWN gate call (its own schema, its own log row). No
//     query ever spans two schemas; an ENDED engagement simply is not in the list.
//   * RECIPROCAL VIEW — an MSME_OWNER sees every engagement on their own business, and
//     for each one the goals, indicator targets, action items and sessions set on it,
//     plus the access log of who read their books. Transparency is the default; there is
//     no setting that hides a mentor's reads from the business they read.
// ===========================================================================

import { platformDb } from "../../db/platform";
import type { Cents } from "../../lib/money";
import { resolvePeriod, type Period } from "../reports";
import { withEngagedTenant } from "./access";
import {
  computeKpiValue,
  listActionItems,
  listGoals,
  listIndicators,
  listSessions,
  standingOf,
  toIndicatorRow,
  type ActionItemRow,
  type GoalRow,
  type IndicatorRow,
  type IndicatorStanding,
  type SessionRow,
} from "./coaching";
import {
  getVisibleEngagement,
  isMentorRole,
  listAccessLog,
  listEngagements,
  MentorshipNotFoundError,
  type AccessLogRow,
  type EngagementRow,
  type MentorshipActor,
} from "./engagements";

/** How many sessions the dashboard shows; the full list is GET /engagements/{id}/sessions. */
const RECENT_SESSIONS = 5;

export interface DashboardIndicator extends IndicatorRow {
  actualAmount: Cents | null;
  actualRate: string | null;
  unavailableReason: string | null;
  standing: IndicatorStanding;
}

export interface ActionPlan {
  open: ActionItemRow[];
  closed: ActionItemRow[];
}

export interface EngagementDashboard {
  engagement: EngagementRow;
  /** The month to date the KPI flows cover; balances are as at `period.to`. */
  period: Period;
  indicators: DashboardIndicator[];
  goals: GoalRow[];
  actionItems: ActionPlan;
  recentSessions: SessionRow[];
  sessionCount: number;
  computedAt: Date;
}

function splitPlan(items: ActionItemRow[]): ActionPlan {
  return {
    open: items.filter((i) => i.status === "OPEN"),
    closed: items.filter((i) => i.status !== "OPEN"),
  };
}

/** This mentor's engagement, and only while ACTIVE — anything else is the same 404. */
async function activeOwnEngagement(actor: MentorshipActor, engagementId: string): Promise<EngagementRow> {
  if (!isMentorRole(actor.role)) {
    throw new MentorshipNotFoundError();
  }
  const engagement = await getVisibleEngagement(actor, engagementId);
  if (engagement.status !== "ACTIVE") {
    throw new MentorshipNotFoundError();
  }
  return engagement;
}

/**
 * ONE engagement, composed for the mentor: the mentee, each indicator's target against
 * its LIVE actual, goals, the action plan and the recent sessions. 404 unless it is this
 * mentor's ACTIVE engagement (an ended one is history, read through the 14.2 lists).
 */
export async function buildEngagementDashboard(actor: MentorshipActor, engagementId: string): Promise<EngagementDashboard> {
  const engagement = await activeOwnEngagement(actor, engagementId);
  const indicators = await listIndicators(actor, engagementId);
  const period = resolvePeriod({});

  // No agreed indicators means nothing to read: the business's books are not opened and
  // no access is logged for a view that showed none of them.
  const withActuals: DashboardIndicator[] =
    indicators.length === 0
      ? []
      : await withEngagedTenant(
          actor.userId,
          engagementId,
          `dashboard:${[...new Set(indicators.map((i) => i.sourceKey))].join(",")}`,
          async (source) => {
            const out: DashboardIndicator[] = [];
            for (const indicator of indicators) {
              const value = await computeKpiValue(source, indicator.sourceKey, period);
              out.push({
                ...indicator,
                actualAmount: value.amount,
                actualRate: value.rate,
                unavailableReason: value.unavailableReason,
                standing: standingOf(indicator, value),
              });
            }
            return out;
          },
        );

  const [goals, items, sessions] = await Promise.all([
    listGoals(actor, engagementId),
    listActionItems(actor, engagementId),
    listSessions(actor, engagementId),
  ]);
  return {
    engagement,
    period,
    indicators: withActuals,
    goals,
    actionItems: splitPlan(items),
    recentSessions: sessions.slice(0, RECENT_SESSIONS),
    sessionCount: sessions.length,
    computedAt: new Date(),
  };
}

export interface CohortMember {
  engagement: EngagementRow;
  period: Period;
  revenue: Cents;
  cashPosition: Cents;
  grossMarginPct: string | null;
  grossMarginUnavailableReason: string | null;
  openActionItems: number;
}

export interface Cohort {
  members: CohortMember[];
  computedAt: Date;
}

/**
 * THE SANCTIONED CROSS-TENANT COHORT ROLL-UP. The mentor's ACTIVE engagements on ACTIVE
 * businesses, each with its headline KPIs (month-to-date revenue, cash position, gross
 * margin) read through THAT engagement's own gate call — one schema, one READ ONLY
 * transaction and one logged read per mentee. Figures are never combined across
 * businesses: each member stands alone.
 */
export async function buildCohort(actor: MentorshipActor): Promise<Cohort> {
  if (!isMentorRole(actor.role)) {
    return { members: [], computedAt: new Date() };
  }
  const engagements = (await listEngagements(actor)).filter((e) => e.status === "ACTIVE");
  const active = await platformDb.tenant.findMany({
    where: { id: { in: engagements.map((e) => e.tenantId) }, status: "ACTIVE" },
    select: { id: true },
  });
  const activeTenants = new Set(active.map((t) => t.id));
  const period = resolvePeriod({});

  const members: CohortMember[] = [];
  for (const engagement of engagements) {
    if (!activeTenants.has(engagement.tenantId)) continue;
    const headline = await withEngagedTenant(actor.userId, engagement.id, "cohort", async (source) => ({
      revenue: await computeKpiValue(source, "MONTHLY_REVENUE", period),
      cash: await computeKpiValue(source, "CASH_POSITION", period),
      margin: await computeKpiValue(source, "GROSS_MARGIN_PCT", period),
    }));
    const openActionItems = await platformDb.actionItem.count({
      where: { engagementId: engagement.id, status: "OPEN" },
    });
    members.push({
      engagement,
      period,
      revenue: headline.revenue.amount ?? 0n,
      cashPosition: headline.cash.amount ?? 0n,
      grossMarginPct: headline.margin.rate,
      grossMarginUnavailableReason: headline.margin.unavailableReason,
      openActionItems,
    });
  }
  return { members, computedAt: new Date() };
}

// ---------------------------------------------------------------------------
// The entrepreneur's reciprocal view
// ---------------------------------------------------------------------------

function requireOwner(actor: MentorshipActor): void {
  if (actor.role !== "MSME_OWNER" || actor.tenantId === null) {
    throw new MentorshipNotFoundError();
  }
}

/** Every engagement on the owner's OWN business, any status. */
export async function listMyEngagements(actor: MentorshipActor): Promise<EngagementRow[]> {
  requireOwner(actor);
  return listEngagements(actor);
}

export interface OwnerEngagementView {
  engagement: EngagementRow;
  goals: GoalRow[];
  /** The agreed targets. The owner reads the actuals in their own Module 13 reports. */
  indicators: IndicatorRow[];
  actionItems: ActionPlan;
  sessions: SessionRow[];
  /** Who read this business's books under the engagement, what, and when. */
  accessLog: AccessLogRow[];
}

/**
 * The owner's view of ONE engagement on their own business — readable at any status,
 * including after it ENDS. 404 for an engagement on any other business.
 */
export async function getMyEngagementView(actor: MentorshipActor, engagementId: string): Promise<OwnerEngagementView> {
  requireOwner(actor);
  const engagement = await getVisibleEngagement(actor, engagementId);
  const where = { engagementId: engagement.id };
  const [goals, indicators, items, sessions, accessLog] = await Promise.all([
    platformDb.goal.findMany({ where, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    platformDb.performanceIndicator.findMany({ where, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    platformDb.actionItem.findMany({ where, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    platformDb.coachingSession.findMany({ where, orderBy: [{ sessionDate: "desc" }, { createdAt: "desc" }] }),
    listAccessLog(actor, engagement.id),
  ]);
  return {
    engagement,
    goals,
    indicators: indicators.map(toIndicatorRow),
    actionItems: splitPlan(items),
    sessions,
    accessLog,
  };
}
