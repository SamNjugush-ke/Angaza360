// ===========================================================================
// THE MAINTENANCE JOBS (M4.5 Wave 4) — each one a thin, IDEMPOTENT wrapper over the service that
// already owns the work. Running a job twice changes nothing the second time, and a retry can never
// post a second payment, receipt, stock movement, ledger entry or notification, because:
//
//   etims-retry          retries QUEUED invoices with the SAME invoice number (the no-double-file
//                        rule); a SIGNED or REJECTED invoice is never touched again
//   expire-leases        freezes a device's allocation once and ENDS its lease, so the next run finds
//                        nothing; a freeze posts no entry and moves no stock
//   expire-mpesa         times out INITIATED pushes under the row lock; a terminal push is never
//                        rewritten (0009's guard); a paid-awaiting-receipt push is never timed out
//   mpesa-reconcile      asks Safaricom about pending pushes; a confirmation goes through the one
//                        row-locked path; a success with no receipt posts nothing
//   expire-tokens        marks past-due invitations EXPIRED; removes long-expired reset codes and
//                        login challenges (single-use secrets that can no longer be used)
//   export-cleanup       expires downloadable export files past their window (ciphertext removed)
//                        and fails interrupted builds
//   notification-sweep   closes deliveries stuck QUEUED (a send interrupted mid-way) as FAILED, so
//                        no failure silently disappears; it NEVER re-sends — a body is stored
//                        nowhere, and re-sending a secret is the owning flow's job (re-invite, a new
//                        reset code). Decided for M4.5 W4.
//   application-documents-purge  the W2 retention schedule for applicants' ID documents
//
// A tenant job visits every ACTIVE business in its own schema. A business that has not set the
// integration up (no credential, switched off) is skipped, not failed.
// ===========================================================================

import { resolveTenantContext } from "../../auth/tenant-registry";
import { platformDb } from "../../db/platform";
import { getTenantDb } from "../../db/tenant";
import { NoActiveCredentialError } from "../credentials/credential-store";
import { EtimsNotConfiguredError, retryQueuedInvoices } from "../etims/etims-signing";
import { EtimsDisabledError } from "../etims/factory";
import { cleanupExports } from "../export/files";
import { IntegrationDisabledError } from "../mpesa/factory";
import { expireStalePending, reconcilePendingMpesa } from "../mpesa/payment";
import { expireLeases } from "../offline/freeze";
import { purgeExpiredDocuments } from "../tenants/documents";

export type JobSummary = Record<string, number>;

export interface JobDefinition {
  name: string;
  description: string;
  /** The suggested Cloud Scheduler cadence (deploy-time config; recorded here for the read API). */
  suggestedSchedule: string;
  run(now: Date): Promise<JobSummary>;
}

/** A per-business job: visits every ACTIVE business; "not set up" is a skip, not a failure. */
async function forEachBusiness(
  work: (tenant: { id: string; dbSchema: string }) => Promise<JobSummary>,
  isSkip: (error: unknown) => boolean = () => false,
): Promise<JobSummary> {
  const tenants = await platformDb.tenant.findMany({ where: { status: "ACTIVE" }, select: { id: true, dbSchema: true }, orderBy: { subdomain: "asc" } });
  const total: JobSummary = { businesses: tenants.length, skipped: 0 };
  for (const tenant of tenants) {
    try {
      const part = await work(tenant);
      for (const [key, value] of Object.entries(part)) total[key] = (total[key] ?? 0) + value;
    } catch (error) {
      if (!isSkip(error)) throw error;
      total.skipped = (total.skipped ?? 0) + 1;
    }
  }
  return total;
}

const notSetUp = (error: unknown) =>
  error instanceof NoActiveCredentialError || error instanceof EtimsNotConfiguredError || error instanceof EtimsDisabledError || error instanceof IntegrationDisabledError;

export const JOBS: readonly JobDefinition[] = [
  {
    name: "etims-retry",
    description: "Retry KRA eTIMS invoices queued while KRA was unreachable — with the same invoice number.",
    suggestedSchedule: "every 15 minutes",
    run: () =>
      forEachBusiness(async (tenant) => {
        const result = await retryQueuedInvoices(getTenantDb(tenant.dbSchema), 10);
        return { attempted: result.attempted, signed: result.signed, rejected: result.rejected, stillQueued: result.stillQueued, exhausted: result.exhausted };
      }, notSetUp),
  },
  {
    name: "expire-leases",
    description: "Freeze the stock of offline tills whose lease ran out without syncing.",
    suggestedSchedule: "every 15 minutes",
    run: (now) =>
      forEachBusiness(async (tenant) => {
        const result = await expireLeases(getTenantDb(tenant.dbSchema), now);
        return { devicesChecked: result.results.length, frozen: result.frozenCount };
      }),
  },
  {
    name: "expire-mpesa",
    description: "Time out M-Pesa prompts nobody answered (never one Safaricom says was paid).",
    suggestedSchedule: "every 5 minutes",
    run: () =>
      forEachBusiness(async (tenant) => {
        const result = await expireStalePending(getTenantDb(tenant.dbSchema), 5);
        return { timedOut: result.expired };
      }),
  },
  {
    name: "mpesa-reconcile",
    description: "Ask Safaricom about M-Pesa prompts whose callback never arrived.",
    suggestedSchedule: "every 10 minutes",
    run: () =>
      forEachBusiness(async (tenant) => {
        const report = await reconcilePendingMpesa(getTenantDb(tenant.dbSchema), await resolveTenantContext(tenant.id), { olderThanMinutes: 2 });
        const summary: JobSummary = { examined: report.examined };
        for (const outcome of report.outcomes) summary[outcome.result] = (summary[outcome.result] ?? 0) + 1;
        return summary;
      }, notSetUp),
  },
  {
    name: "expire-tokens",
    description: "Mark past-due invitations expired; remove long-expired reset codes and sign-in challenges.",
    suggestedSchedule: "hourly",
    async run(now) {
      const invitations = await platformDb.userInvitation.updateMany({ where: { status: "PENDING", expiresAt: { lte: now } }, data: { status: "EXPIRED" } });
      const resetCodes = await platformDb.passwordResetToken.deleteMany({ where: { expiresAt: { lte: new Date(now.getTime() - 7 * 86_400_000) } } });
      const challenges = await platformDb.loginChallenge.deleteMany({ where: { expiresAt: { lte: new Date(now.getTime() - 86_400_000) } } });
      return { invitationsExpired: invitations.count, resetCodesRemoved: resetCodes.count, challengesRemoved: challenges.count };
    },
  },
  {
    name: "export-cleanup",
    description: "Expire report export files past their download window, and fail interrupted builds.",
    suggestedSchedule: "every 15 minutes",
    async run(now) {
      const platform = await cleanupExports({ kind: "platform" }, now);
      const businesses = await forEachBusiness(async (tenant) => {
        const result = await cleanupExports({ kind: "tenant", db: getTenantDb(tenant.dbSchema), tenantId: tenant.id }, now);
        return { expired: result.expired, interrupted: result.interrupted };
      });
      return { ...businesses, expired: (businesses.expired ?? 0) + platform.expired, interrupted: (businesses.interrupted ?? 0) + platform.interrupted };
    },
  },
  {
    name: "notification-sweep",
    description: "Close deliveries stuck sending as failed, so none silently disappears. Never re-sends.",
    suggestedSchedule: "every 15 minutes",
    async run(now) {
      const stuck = await platformDb.notificationLog.updateMany({
        where: { status: "QUEUED", createdAt: { lte: new Date(now.getTime() - 15 * 60_000) } },
        data: { status: "FAILED", error: "The send was interrupted before the provider answered. Nothing is re-sent automatically: send it again from where it started (a new invitation or reset code)." },
      });
      const failedLastDay = await platformDb.notificationLog.count({ where: { status: "FAILED", createdAt: { gte: new Date(now.getTime() - 86_400_000) } } });
      return { interruptedClosed: stuck.count, failedLast24h: failedLastDay };
    },
  },
  {
    name: "application-documents-purge",
    description: "Remove applicants' ID documents on the retention schedule (decided + 180 days; idle drafts + 30 days).",
    suggestedSchedule: "daily",
    async run(now) {
      const report = await purgeExpiredDocuments(now);
      return { documentsPurged: report.purged, applications: report.applications };
    },
  },
];

export function findJob(name: string): JobDefinition | undefined {
  return JOBS.find((job) => job.name === name);
}
