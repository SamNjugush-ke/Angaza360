// ===========================================================================
// The donor-cohort AGGREGATE (Task T-A12) — the second sanctioned cross-tenant read, built
// on the SAME consented, logged, READ-ONLY gate as mentorship.
//
// For a project's period it reads EACH member business that is CONSENTED (and whose
// business is ACTIVE) through `withConsentedTenantReadOnly`: one donor_access_logs row per
// business BEFORE its data is returned, then that business's own Module 13 income
// statement inside a READ ONLY transaction. A PENDING or WITHDRAWN member is never opened —
// it appears only in the membership counts. The businesses are never combined in SQL: each
// is read through its own gate call and the cohort figures are summed afterwards.
//
// The output is AGGREGATE — businesses included, total and median revenue, total net
// profit, revenue growth against the preceding equal period — plus per-business figures for
// the CONSENTED members only, for platform staff only (the route's guard).
// ===========================================================================

import { platformDb } from "../../db/platform";
import type { Cents } from "../../lib/money";
import { roundHalfUp } from "../../lib/money";
import { buildIncomeStatement, type Period, type ReportSource } from "../reports";
import type { Actor } from "../identity/user-management";
import { withConsentedTenantReadOnly } from "../tenant-read-gate";
import { DonorError, loadProject } from "./projects";

export interface CohortMemberFigures {
  readonly tenantId: string;
  readonly businessName: string;
  readonly revenue: Cents;
  readonly comparativeRevenue: Cents;
  readonly netProfit: Cents;
}

export interface CohortAggregate {
  readonly projectId: string;
  readonly code: string;
  readonly period: Period;
  readonly comparativePeriod: Period | null;
  readonly members: {
    readonly total: number;
    readonly consented: number;
    readonly pending: number;
    readonly withdrawn: number;
    /** Consented, but the business is not ACTIVE: not read. */
    readonly consentedButInactive: number;
  };
  readonly businessesIncluded: number;
  readonly totalRevenue: Cents;
  readonly medianRevenue: Cents;
  readonly totalNetProfit: Cents;
  /** (revenue − comparative) ÷ comparative × 100, to 2 places; null when there was none. */
  readonly revenueGrowthPct: string | null;
  readonly consentedMembers: CohortMemberFigures[];
}

/**
 * THE DONOR READ GATE: run ONE read of a member business's books for a project — logged
 * to donor_access_logs first (the database refuses the log, and so the read, unless the
 * member is CONSENTED and the project ACTIVE), then inside a READ ONLY transaction through
 * the shared gate. Every cohort read goes through here.
 */
export function withConsentedMember<T>(
  actor: Actor,
  projectId: string,
  member: { readonly tenantId: string; readonly dbSchema: string },
  resource: string,
  read: (source: ReportSource) => Promise<T>,
): Promise<T> {
  return withConsentedTenantReadOnly(
    member.dbSchema,
    async () => {
      await platformDb.donorAccessLog.create({ data: { projectId, tenantId: member.tenantId, readerUserId: actor.userId, resource } });
    },
    read,
  );
}

function median(values: readonly Cents[]): Cents {
  if (values.length === 0) return 0n;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0n;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[middle - 1] ?? 0n;
  return roundHalfUp(lower + upper, 2n);
}

/** A ratio as a percentage to 2 places, rounded once (the 14.2 KPI convention). */
function percentChange(current: Cents, previous: Cents): string | null {
  if (previous === 0n) return null;
  const hundredths = roundHalfUp((current - previous) * 10_000n, previous);
  const sign = hundredths < 0n ? "-" : "";
  const magnitude = hundredths < 0n ? -hundredths : hundredths;
  return `${sign}${(magnitude / 100n).toString()}.${(magnitude % 100n).toString().padStart(2, "0")}`;
}

export async function buildCohortAggregate(actor: Actor, projectId: string, period: Period): Promise<CohortAggregate> {
  const project = await loadProject(projectId);
  if (project.status !== "ACTIVE") {
    throw new DonorError(409, `Donor project ${project.code} is CLOSED; its members' books are no longer read.`);
  }
  const memberships = await platformDb.donorProjectMembership.findMany({
    where: { projectId },
    orderBy: [{ joinedAt: "asc" }],
    select: { tenantId: true, consentStatus: true, tenant: { select: { name: true, dbSchema: true, status: true } } },
  });

  const figures: CohortMemberFigures[] = [];
  let comparativePeriod: Period | null = null;
  let consentedButInactive = 0;
  for (const member of memberships) {
    if (member.consentStatus !== "CONSENTED") continue;
    if (member.tenant.status !== "ACTIVE") {
      consentedButInactive += 1;
      continue;
    }
    const statement = await withConsentedMember(
      actor,
      projectId,
      { tenantId: member.tenantId, dbSchema: member.tenant.dbSchema },
      "cohort-aggregate:income-statement",
      (source) => buildIncomeStatement(source, period, true),
    );
    comparativePeriod = statement.comparativePeriod;
    figures.push({
      tenantId: member.tenantId,
      businessName: member.tenant.name,
      revenue: statement.revenue.total,
      comparativeRevenue: statement.revenue.comparativeTotal ?? 0n,
      netProfit: statement.netProfit.amount,
    });
  }

  const totalRevenue = figures.reduce((sum, f) => sum + f.revenue, 0n);
  const totalComparative = figures.reduce((sum, f) => sum + f.comparativeRevenue, 0n);
  const count = (status: string) => memberships.filter((m) => m.consentStatus === status).length;
  return {
    projectId,
    code: project.code,
    period,
    comparativePeriod,
    members: {
      total: memberships.length,
      consented: count("CONSENTED"),
      pending: count("PENDING"),
      withdrawn: count("WITHDRAWN"),
      consentedButInactive,
    },
    businessesIncluded: figures.length,
    totalRevenue,
    medianRevenue: median(figures.map((f) => f.revenue)),
    totalNetProfit: figures.reduce((sum, f) => sum + f.netProfit, 0n),
    revenueGrowthPct: percentChange(totalRevenue, totalComparative),
    consentedMembers: figures,
  };
}
