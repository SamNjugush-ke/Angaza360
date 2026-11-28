// ===========================================================================
// THE MENTOR SNAPSHOT (Module 14, Task 14.1) — the minimal engagement-scoped read that
// proves the access gate end to end. The full KPI set, goals and sessions are 14.2.
//
// It computes NOTHING of its own. Every figure is the Module 13 engine's, run through
// the gate against the one business the ACTIVE engagement grants: this month's revenue,
// gross and net profit from `buildIncomeStatement`, and the cash position from
// `buildCashFlow` (closing cash & equivalents). So a mentor sees exactly the numbers the
// owner's own reports show for the same period — there is no second way to compute them.
// ===========================================================================

import type { Cents } from "../../lib/money";
import { buildCashFlow, buildIncomeStatement, resolvePeriod, type Period } from "../reports";
import { withEngagedTenant } from "./access";

export interface MentorSnapshot {
  engagementId: string;
  tenantId: string;
  businessName: string;
  /** The current month to date, in the business's own calendar (Africa/Nairobi). */
  period: Period;
  revenue: Cents;
  grossProfit: Cents;
  netProfit: Cents;
  /** Cash & equivalents {1000, 1010, 1015, 1020} at the end of the period. */
  cashPosition: Cents;
}

export async function buildMentorSnapshot(mentorId: string, engagementId: string): Promise<MentorSnapshot> {
  return withEngagedTenant(mentorId, engagementId, "snapshot", async (source, tenant) => {
    const period = resolvePeriod({});
    const income = await buildIncomeStatement(source, period, false);
    const cash = await buildCashFlow(source, period, false);
    return {
      engagementId: tenant.engagementId,
      tenantId: tenant.tenantId,
      businessName: tenant.businessName,
      period,
      revenue: income.revenue.total,
      grossProfit: income.grossProfit.amount,
      netProfit: income.netProfit.amount,
      cashPosition: cash.closingCash.amount,
    };
  });
}
