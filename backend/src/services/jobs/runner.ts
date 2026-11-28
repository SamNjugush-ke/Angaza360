// ===========================================================================
// THE JOB RUNNER (M4.5 Wave 4) — robust, NOT an in-process timer.
//
// Something outside the process decides WHEN (GCP Cloud Scheduler calling the protected trigger
// endpoint, or an operator's CLI); this decides HOW, the same way for both:
//
//   1. IDEMPOTENT TRIGGER. A run is keyed `(jobName, idempotencyKey)` — UNIQUE in `job_runs`. A
//      second delivery of the same trigger (a scheduler retry) gets the FIRST run back; nothing
//      runs twice.
//   2. LOCKED. A Postgres advisory lock per job (`pg_try_advisory_lock`, held on one connection for
//      the run) lets one instance run a job at a time, across every API instance. A run that finds
//      the lock taken is recorded SKIPPED — not dropped.
//   3. BOUNDED RETRIES. A failing attempt is retried up to MAX_ATTEMPTS times with a short backoff;
//      every job is idempotent, so a retry can only finish what the failed attempt did not.
//   4. NOTHING DISAPPEARS. Every run is a row: RUNNING, then SUCCEEDED (with its counts) or FAILED
//      (with the reason). A run left RUNNING by a crash is closed FAILED ("interrupted") by the next
//      run of that job, once the lock shows nobody is still working on it.
//
// The ONLY writer of `job_runs`. The database guards the rest (`job_run_guard`).
// ===========================================================================

import { randomUUID } from "node:crypto";
import type { Prisma } from "../../generated/platform/client";
import { platformDb } from "../../db/platform";
import { pool } from "../../db/pool";
import { findJob, JOBS, type JobSummary } from "./jobs";

export const MAX_ATTEMPTS = 3;
/** Backoff between attempts, in ms (swappable for tests). */
export const retryBackoff = { ms: (attempt: number) => 1_000 * attempt };

/** SCHEDULER: the machine trigger (secret or Google OIDC). CLI: an operator. CONSOLE: a SUPER_ADMIN in the Command Center (W5). */
export type JobTrigger = "SCHEDULER" | "CLI" | "CONSOLE";

export class UnknownJobError extends Error {
  constructor(name: string) {
    super(`No job named "${name}". Known jobs: ${JOBS.map((j) => j.name).join(", ")}.`);
    this.name = "UnknownJobError";
  }
}

export interface JobRunView {
  id: string;
  jobName: string;
  trigger: string;
  idempotencyKey: string;
  requestedBy: string | null;
  status: string;
  attempts: number;
  summary: Prisma.JsonValue | null;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

const SELECT = { id: true, jobName: true, trigger: true, idempotencyKey: true, requestedBy: true, status: true, attempts: true, summary: true, error: true, startedAt: true, finishedAt: true } as const;

/** A safe one-line reason: the error's name and the start of its message, never a stack. */
function reasonOf(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 500);
  return "Unknown error";
}

/** The default trigger key: the job and the minute, so a duplicate delivery in the same minute is one run. */
export function minuteKey(now: Date): string {
  return now.toISOString().slice(0, 16);
}

/**
 * Runs a job once for this trigger. Returns the run — the existing one when the same
 * `idempotencyKey` was already used for this job.
 */
export async function runJob(name: string, trigger: JobTrigger, idempotencyKey: string, now: Date = new Date(), requestedBy: string | null = null): Promise<JobRunView> {
  if ((trigger === "CONSOLE") !== (requestedBy !== null)) throw new Error("A console run names the administrator who started it; no other run does.");
  const job = findJob(name);
  if (job === undefined) throw new UnknownJobError(name);

  const existing = await platformDb.jobRun.findUnique({ where: { jobName_idempotencyKey: { jobName: name, idempotencyKey } }, select: SELECT });
  if (existing !== null) return existing;

  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [`angaza-job:${name}`]);
    locked = lock.rows[0]?.locked === true;
    if (!locked) {
      return await recordOnce(name, trigger, idempotencyKey, requestedBy, {
        status: "SKIPPED",
        attempts: 0,
        error: "Another run of this job was still in progress, so this one did nothing.",
        finishedAt: new Date(),
      });
    }

    // Holding the lock: any run of this job still marked RUNNING died mid-way. Close it.
    await platformDb.jobRun.updateMany({
      where: { jobName: name, status: "RUNNING" },
      data: { status: "FAILED", error: "Interrupted: the process stopped before this run finished.", finishedAt: new Date() },
    });

    const run = await recordOnce(name, trigger, idempotencyKey, requestedBy, { status: "RUNNING", attempts: 0 });
    if (run.status !== "RUNNING") return run;

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await platformDb.jobRun.update({ where: { id: run.id }, data: { attempts: attempt } });
      try {
        const summary: JobSummary = await job.run(now);
        return await platformDb.jobRun.update({ where: { id: run.id }, data: { status: "SUCCEEDED", summary, finishedAt: new Date() }, select: SELECT });
      } catch (error) {
        lastError = error;
        if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, retryBackoff.ms(attempt)));
      }
    }
    return await platformDb.jobRun.update({ where: { id: run.id }, data: { status: "FAILED", error: `${reasonOf(lastError)} (after ${MAX_ATTEMPTS.toString()} attempts)`, finishedAt: new Date() }, select: SELECT });
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [`angaza-job:${name}`]).catch(() => undefined);
    client.release();
  }
}

/** Inserts the run, or — when a concurrent delivery of the same key won the race — returns that one. */
async function recordOnce(
  name: string,
  trigger: JobTrigger,
  idempotencyKey: string,
  requestedBy: string | null,
  data: { status: "RUNNING" | "SKIPPED"; attempts: number; error?: string; finishedAt?: Date },
): Promise<JobRunView> {
  try {
    return await platformDb.jobRun.create({ data: { id: randomUUID(), jobName: name, trigger, idempotencyKey, requestedBy, ...data }, select: SELECT });
  } catch (error) {
    const again = await platformDb.jobRun.findUnique({ where: { jobName_idempotencyKey: { jobName: name, idempotencyKey } }, select: SELECT });
    if (again !== null) return again;
    throw error;
  }
}

export interface JobRunFilter {
  jobName?: string;
  status?: string;
  take: number;
  skip: number;
}

export async function listJobRuns(filter: JobRunFilter): Promise<{ data: JobRunView[]; total: number }> {
  const where = { ...(filter.jobName ? { jobName: filter.jobName } : {}), ...(filter.status ? { status: filter.status } : {}) };
  const [data, total] = await Promise.all([
    platformDb.jobRun.findMany({ where, orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: filter.take, skip: filter.skip, select: SELECT }),
    platformDb.jobRun.count({ where }),
  ]);
  return { data, total };
}

/** Every job with its last run. */
export async function listJobs(): Promise<Array<{ name: string; description: string; suggestedSchedule: string; lastRun: JobRunView | null }>> {
  return Promise.all(
    JOBS.map(async (job) => ({
      name: job.name,
      description: job.description,
      suggestedSchedule: job.suggestedSchedule,
      lastRun: await platformDb.jobRun.findFirst({ where: { jobName: job.name }, orderBy: [{ startedAt: "desc" }, { id: "desc" }], select: SELECT }),
    })),
  );
}
