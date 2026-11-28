// ===========================================================================
// THE SCHEDULER AND THE JOB REGISTRY (M4.5 W4).
//
// Proven: every job is IDEMPOTENT — run twice, the second run moves nothing (journal entries, stock
// movements and notifications counted before and after) — and records its run; the same trigger
// key twice runs once; a job already running elsewhere (its lock held) is recorded SKIPPED; a
// failing job is retried a bounded number of times and recorded FAILED with its reason; a run left
// RUNNING by a crash is closed "interrupted"; the notification sweep closes stuck deliveries and
// re-sends NOTHING; the trigger endpoint answers a bare 404 to a missing or wrong secret (before
// it even validates the job name) and the read API is for platform staff; `job_runs` is guarded
// from raw SQL.
// ===========================================================================

import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { platformDb } from "../../src/db/platform";
import { pool } from "../../src/db/pool";
import { buildServer } from "../../src/server";
import { JOBS } from "../../src/services/jobs/jobs";
import { retryBackoff, runJob } from "../../src/services/jobs/runner";
import { simulatedOutbox } from "../../src/services/notifications/simulated-provider";
import { bearer, createStaffUser, signIn, type SignedIn, type StaffUser } from "../identity/staff-fixture";
import { freshIp } from "../security/http-app";
import { tenantDb, tenantIdOf } from "../setup/tenant";
import { expectDbRefusal } from "../support/db-errors";
import { withPlatformTx } from "../support/platform-tx";

let app: FastifyInstance;
const users: StaffUser[] = [];
let admin: SignedIn;
let owner: SignedIn;
const SECRET = randomBytes(24).toString("hex");
const keyOf = (label: string) => `test:${label}:${randomBytes(6).toString("hex")}`;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  const adminUser = await createStaffUser("SUPER_ADMIN", null);
  const ownerUser = await createStaffUser("MSME_OWNER", await tenantIdOf());
  users.push(adminUser, ownerUser);
  admin = await signIn(app, adminUser);
  owner = await signIn(app, ownerUser);
});

beforeEach(() => {
  retryBackoff.ms = () => 0;
  process.env.JOB_TRIGGER_SECRET = SECRET;
});

afterAll(async () => {
  delete process.env.JOB_TRIGGER_SECRET;
  await platformDb.userInvitation.deleteMany({ where: { invitedById: { in: users.map((u) => u.id) } } });
  await platformDb.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await app.close();
});

/** What a retry must never duplicate: ledger, stock and notifications (and the outbox). */
async function footprint(): Promise<Record<string, number>> {
  const db = tenantDb();
  const [entries, movements, notifications] = await Promise.all([db.journalEntry.count(), db.stockMovement.count(), platformDb.notificationLog.count()]);
  return { entries, movements, notifications, outbox: simulatedOutbox().length };
}

describe("every job is idempotent and recorded", () => {
  it("runs each job twice: both runs succeed and are recorded, and the second moves nothing", async () => {
    // Something for the token and notification jobs to do on the first run only.
    await platformDb.userInvitation.create({
      data: { email: `stale-${randomBytes(4).toString("hex")}@test.invalid`, role: "CASHIER", tenantId: await tenantIdOf(), invitedById: users[0]?.id ?? "", tokenHash: randomBytes(32).toString("hex"), status: "PENDING", expiresAt: new Date(Date.now() - 60_000), createdAt: new Date(Date.now() - 3_600_000) },
    });
    const stuck = await platformDb.notificationLog.create({ data: { channel: "EMAIL", recipient: "x@test.invalid", templateKey: "user-invitation", providerName: "simulated", createdAt: new Date(Date.now() - 3_600_000) } });

    for (const job of JOBS) {
      const first = await runJob(job.name, "CLI", keyOf(`${job.name}-1`));
      expect([job.name, first.status, first.attempts]).toEqual([job.name, "SUCCEEDED", 1]);
      const before = await footprint();
      const second = await runJob(job.name, "CLI", keyOf(`${job.name}-2`));
      expect([job.name, second.status]).toEqual([job.name, "SUCCEEDED"]);
      expect(await footprint()).toEqual(before);
      const counts = Object.entries((second.summary ?? {}) as Record<string, number>).filter(([key]) => !["businesses", "skipped", "devicesChecked", "examined", "failedLast24h"].includes(key));
      expect([job.name, counts.filter(([, value]) => value !== 0)]).toEqual([job.name, []]);
    }
    // The first runs did their work.
    expect((await platformDb.notificationLog.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe("FAILED");
    expect(await platformDb.userInvitation.count({ where: { invitedById: users[0]?.id, status: "EXPIRED" } })).toBe(1);
  });

  it("the notification sweep closes a stuck delivery and re-sends nothing", async () => {
    const stuck = await platformDb.notificationLog.create({ data: { channel: "SMS", recipient: "+254700000000", templateKey: "password-reset", providerName: "simulated", createdAt: new Date(Date.now() - 3_600_000) } });
    const outboxBefore = simulatedOutbox().length;
    const run = await runJob("notification-sweep", "CLI", keyOf("sweep"));
    expect((run.summary as Record<string, number>).interruptedClosed).toBe(1);
    const row = await platformDb.notificationLog.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(row.status).toBe("FAILED");
    expect(row.error).toMatch(/Nothing is re-sent automatically/);
    expect(simulatedOutbox().length).toBe(outboxBefore);
  });
});

describe("the runner", () => {
  it("the same trigger key twice runs once", async () => {
    const key = keyOf("dup");
    const spy = vi.spyOn(JOBS.find((j) => j.name === "expire-tokens") as (typeof JOBS)[number], "run");
    const a = await runJob("expire-tokens", "SCHEDULER", key);
    const b = await runJob("expire-tokens", "SCHEDULER", key);
    expect(b.id).toBe(a.id);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await platformDb.jobRun.count({ where: { jobName: "expire-tokens", idempotencyKey: key } })).toBe(1);
    spy.mockRestore();
  });

  it("a job already running elsewhere is recorded SKIPPED, never dropped", async () => {
    const holder = await pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtext($1))", ["angaza-job:export-cleanup"]);
      const run = await runJob("export-cleanup", "SCHEDULER", keyOf("locked"));
      expect(run).toMatchObject({ status: "SKIPPED", attempts: 0 });
      expect(run.error).toMatch(/still in progress/);
    } finally {
      await holder.query("SELECT pg_advisory_unlock(hashtext($1))", ["angaza-job:export-cleanup"]);
      holder.release();
    }
  });

  it("a failing job is retried a bounded number of times, then recorded FAILED with its reason", async () => {
    const job = JOBS.find((j) => j.name === "expire-tokens") as (typeof JOBS)[number];
    const spy = vi.spyOn(job, "run").mockRejectedValue(new Error("database unreachable"));
    const run = await runJob("expire-tokens", "CLI", keyOf("fails"));
    expect(spy).toHaveBeenCalledTimes(3);
    expect(run).toMatchObject({ status: "FAILED", attempts: 3 });
    expect(run.error).toBe("Error: database unreachable (after 3 attempts)");
    spy.mockRestore();
    // A transient failure that clears on the second attempt succeeds, and says so.
    const flaky = vi.spyOn(job, "run").mockRejectedValueOnce(new Error("blip")).mockResolvedValueOnce({ invitationsExpired: 0 });
    const recovered = await runJob("expire-tokens", "CLI", keyOf("flaky"));
    expect(recovered).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
    flaky.mockRestore();
  });

  it("a run left RUNNING by a crash is closed FAILED by the next run of that job", async () => {
    const orphan = await platformDb.jobRun.create({ data: { jobName: "expire-mpesa", trigger: "SCHEDULER", idempotencyKey: keyOf("orphan"), status: "RUNNING", attempts: 1 } });
    await runJob("expire-mpesa", "SCHEDULER", keyOf("after-crash"));
    const closed = await platformDb.jobRun.findUniqueOrThrow({ where: { id: orphan.id } });
    expect(closed.status).toBe("FAILED");
    expect(closed.error).toMatch(/^Interrupted/);
  });
});

describe("the trigger endpoint and the read API", () => {
  const trigger = (name: string, secret: string | undefined, key?: string) =>
    app.inject({ method: "POST", url: `/v1/internal/jobs/${name}/run`, remoteAddress: freshIp(), headers: { ...(secret !== undefined ? { "x-job-trigger-secret": secret } : {}), ...(key ? { "idempotency-key": key } : {}) } });

  it("answers a bare 404 to a missing or wrong secret — and when none is configured", async () => {
    expect((await trigger("expire-tokens", undefined)).statusCode).toBe(404);
    expect((await trigger("expire-tokens", `${SECRET}x`)).statusCode).toBe(404);
    // The secret is checked before the name is validated: a caller without it learns nothing.
    expect((await trigger("x".repeat(80), "wrong")).statusCode).toBe(404);
    delete process.env.JOB_TRIGGER_SECRET;
    expect((await trigger("expire-tokens", SECRET)).statusCode).toBe(404);
    process.env.JOB_TRIGGER_SECRET = "too-short";
    expect((await trigger("expire-tokens", "too-short")).statusCode).toBe(404);
  });

  it("runs the job with the right secret; the same idempotency key is the same run", async () => {
    const key = keyOf("http");
    const a = await trigger("expire-tokens", SECRET, key);
    expect(a.statusCode).toBe(200);
    expect(a.json<{ status: string; trigger: string }>()).toMatchObject({ status: "SUCCEEDED", trigger: "SCHEDULER" });
    const b = await trigger("expire-tokens", SECRET, key);
    expect(b.json<{ id: string }>().id).toBe(a.json<{ id: string }>().id);
    expect((await trigger("no-such-job", SECRET)).statusCode).toBe(404);
  });

  it("the read API lists the jobs and their runs for platform staff only", async () => {
    const jobs = await app.inject({ method: "GET", url: "/v1/jobs", remoteAddress: freshIp(), headers: bearer(admin.token) });
    expect(jobs.statusCode).toBe(200);
    expect(jobs.json<{ data: Array<{ name: string }> }>().data.map((j) => j.name)).toEqual(JOBS.map((j) => j.name));
    const runs = await app.inject({ method: "GET", url: "/v1/jobs/runs?jobName=expire-tokens&status=FAILED", remoteAddress: freshIp(), headers: bearer(admin.token) });
    expect(runs.json<{ data: Array<{ status: string }> }>().data.every((r) => r.status === "FAILED")).toBe(true);
    expect((await app.inject({ method: "GET", url: "/v1/jobs", remoteAddress: freshIp(), headers: bearer(owner.token) })).statusCode).toBe(403);
    // Job outcomes are in the platform report library too.
    const report = await app.inject({ method: "GET", url: "/v1/platform-reports/job-runs?status=SKIPPED", remoteAddress: freshIp(), headers: bearer(admin.token) });
    expect(report.json<{ sections: Array<{ rows: Array<{ status: string }> }> }>().sections[0]?.rows.every((r) => r.status === "skipped")).toBe(true);
  });
});

describe("job_runs is guarded from raw SQL", () => {
  const insert = (status: string, extra = "") =>
    `INSERT INTO public.job_runs ("id", "jobName", "trigger", "idempotencyKey", "status"${extra ? `, ${extra.split("=")[0] ?? ""}` : ""}) VALUES (gen_random_uuid()::text, 'expire-tokens', 'CLI', '${keyOf("raw")}', '${status}'${extra ? `, ${extra.split("=")[1] ?? ""}` : ""}) RETURNING "id"`;

  it("a run is born RUNNING or SKIPPED, ends once, is never rewritten or deleted — and the legal path is accepted", async () => {
    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(insert("SUCCEEDED")), { fn: "job_run_guard" });
    });
    await withPlatformTx(async (client) => {
      const { rows } = await client.query<{ id: string }>(insert("RUNNING"));
      // The control: RUNNING -> SUCCEEDED is the legal move.
      await client.query(`UPDATE public.job_runs SET "status" = 'SUCCEEDED', "attempts" = 1, "finishedAt" = now() WHERE "id" = $1`, [rows[0]?.id]);
      await expectDbRefusal(client.query(`UPDATE public.job_runs SET "status" = 'FAILED', "error" = 'x' WHERE "id" = $1`, [rows[0]?.id]), { fn: "job_run_guard" });
    });
    await withPlatformTx(async (client) => {
      const { rows } = await client.query<{ id: string }>(insert("RUNNING"));
      await expectDbRefusal(client.query(`DELETE FROM public.job_runs WHERE "id" = $1`, [rows[0]?.id]), { fn: "job_run_guard" });
    });
    await withPlatformTx(async (client) => {
      const { rows } = await client.query<{ id: string }>(insert("RUNNING"));
      await expectDbRefusal(client.query(`UPDATE public.job_runs SET "status" = 'SUCCEEDED', "finishedAt" = now() WHERE "id" = $1`, [rows[0]?.id]), { constraint: "job_runs_status_coherent" });
    });
  });
});
