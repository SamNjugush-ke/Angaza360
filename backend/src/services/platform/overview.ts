// ===========================================================================
// THE COMMAND CENTER'S EXECUTIVE OVERVIEW (M4.5 Wave 5) — GET /v1/platform-reports/overview.
//
// Headline figures composed from PLATFORM data only — never a business's books. Every query is
// bounded: counts are GROUP BYs, lists are capped. Where a figure already has an owner it is
// composed from it rather than re-queried:
//   * job health        <- listJobs() (the jobs read API's own function) + a 24 h failure count;
//   * integration health <- the platform mirror `integration_health` (the same table
//                           GET /v1/tenants/integration-health reads), grouped, and Angaza's own
//                           credentials through listPlatformCredentialsSafe();
//   * recent activity   <- listAuditLog() (GET /v1/users/audit's own function), newest ten.
// Businesses, applications and accounts are counted directly (there is no count endpoint to reuse;
// the detail screens list rows). Each section is what its detail screen shows, so the console's
// tiles reconcile to the screens they link to (proven).
// ===========================================================================

import { platformDb } from "../../db/platform";
import { listPlatformCredentialsSafe } from "../credentials/credential-store";
import { listAuditLog, type AuditView } from "../identity/user-management";
import { listJobs } from "../jobs/runner";
import { OPEN_APPLICATION_STATUSES } from "../tenants/subdomain";

const DAY_MS = 86_400_000;
/** Applications waiting on PLATFORM STAFF — NEEDS_CHANGES waits on the applicant instead. */
const AWAITING_STAFF = ["SUBMITTED", "UNDER_REVIEW"] as const;

export interface PlatformOverview {
  generatedAt: Date;
  businesses: { total: number; byStatus: Record<string, number>; byTier: Record<string, number> };
  applications: {
    byStatus: Record<string, number>;
    open: number;
    awaitingStaff: number;
    oldestAwaitingSince: Date | null;
    oldestAwaitingDays: number | null;
  };
  users: { activeAccounts: number; inactiveAccounts: number; signedInLast30Days: number; platformStaff: number };
  integrations: {
    businesses: Array<{ provider: string; healthy: number; failing: number }>;
    platform: Array<{ provider: string; environment: string; status: string; healthStatus: string; lastHealthCheckAt: Date | null }>;
  };
  jobs: {
    failedLast24h: number;
    list: Array<{ name: string; suggestedSchedule: string; lastStatus: string | null; lastStartedAt: Date | null; lastError: string | null; failedLast24h: number }>;
  };
  recentActivity: AuditView[];
}

const counted = <K extends string>(rows: Array<{ key: K; count: number }>): Record<string, number> =>
  Object.fromEntries(rows.map((r) => [r.key, r.count]));

export async function buildPlatformOverview(
  actor: { userId: string; role: "SUPER_ADMIN" | "PROGRAM_OFFICER"; ipAddress: string | null },
  now: Date = new Date(),
): Promise<PlatformOverview> {
  const since30 = new Date(now.getTime() - 30 * DAY_MS);
  const since24h = new Date(now.getTime() - DAY_MS);

  const [byStatus, byTier, apps, oldest, activeAccounts, inactiveAccounts, recentSignIns, staff, mirror, platformCreds, jobs, failures, activity] = await Promise.all([
    platformDb.tenant.groupBy({ by: ["status"], _count: { _all: true } }),
    platformDb.tenant.groupBy({ by: ["subscriptionTier"], _count: { _all: true } }),
    platformDb.tenantApplication.groupBy({ by: ["status"], where: { status: { not: "DRAFT" } }, _count: { _all: true } }),
    platformDb.tenantApplication.findFirst({ where: { status: { in: [...AWAITING_STAFF] } }, orderBy: [{ submittedAt: "asc" }, { id: "asc" }], select: { submittedAt: true } }),
    platformDb.user.count({ where: { isActive: true } }),
    platformDb.user.count({ where: { isActive: false } }),
    platformDb.user.count({ where: { isActive: true, lastLoginAt: { gte: since30 } } }),
    platformDb.user.count({ where: { isActive: true, tenantId: null } }),
    platformDb.integrationHealth.groupBy({ by: ["provider", "status"], _count: { _all: true } }),
    listPlatformCredentialsSafe(),
    listJobs(),
    platformDb.jobRun.groupBy({ by: ["jobName"], where: { status: "FAILED", startedAt: { gte: since24h } }, _count: { _all: true } }),
    listAuditLog({ userId: actor.userId, role: actor.role, tenantId: null, ipAddress: actor.ipAddress }, { limit: 10, tenantId: null }),
  ]);

  const appsByStatus = counted(apps.map((r) => ({ key: r.status, count: r._count._all })));
  const open = OPEN_APPLICATION_STATUSES.reduce((sum, s) => sum + (appsByStatus[s] ?? 0), 0);
  const awaitingStaff = AWAITING_STAFF.reduce((sum, s) => sum + (appsByStatus[s] ?? 0), 0);
  const oldestAt = oldest?.submittedAt ?? null;

  const providers = [...new Set(mirror.map((r) => r.provider))].sort();
  const failuresByJob = new Map(failures.map((f) => [f.jobName, f._count._all]));
  const businessStatus = counted(byStatus.map((r) => ({ key: r.status, count: r._count._all })));

  return {
    generatedAt: now,
    businesses: {
      total: Object.values(businessStatus).reduce((a, b) => a + b, 0),
      byStatus: businessStatus,
      byTier: counted(byTier.map((r) => ({ key: r.subscriptionTier, count: r._count._all }))),
    },
    applications: {
      byStatus: appsByStatus,
      open,
      awaitingStaff,
      oldestAwaitingSince: oldestAt,
      oldestAwaitingDays: oldestAt === null ? null : Math.floor((now.getTime() - oldestAt.getTime()) / DAY_MS),
    },
    users: { activeAccounts, inactiveAccounts, signedInLast30Days: recentSignIns, platformStaff: staff },
    integrations: {
      businesses: providers.map((provider) => ({
        provider,
        healthy: mirror.filter((r) => r.provider === provider && r.status === "HEALTHY").reduce((a, r) => a + r._count._all, 0),
        failing: mirror.filter((r) => r.provider === provider && r.status === "FAILING").reduce((a, r) => a + r._count._all, 0),
      })),
      platform: platformCreds.map((c) => ({ provider: c.provider, environment: c.environment, status: c.status, healthStatus: c.healthStatus, lastHealthCheckAt: c.lastHealthCheckAt })),
    },
    jobs: {
      failedLast24h: [...failuresByJob.values()].reduce((a, b) => a + b, 0),
      list: jobs.map((j) => ({
        name: j.name,
        suggestedSchedule: j.suggestedSchedule,
        lastStatus: j.lastRun?.status ?? null,
        lastStartedAt: j.lastRun?.startedAt ?? null,
        lastError: j.lastRun?.error ?? null,
        failedLast24h: failuresByJob.get(j.name) ?? 0,
      })),
    },
    recentActivity: activity,
  };
}
