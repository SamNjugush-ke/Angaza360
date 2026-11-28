// ===========================================================================
// Scheduler routes (M4.5 Wave 4).
//
//   POST /v1/internal/jobs/{name}/run   THE MACHINE TRIGGER, for GCP Cloud Scheduler. Not a session
//        route: it is authorised by EITHER a SHARED SECRET in the `x-job-trigger-secret` header,
//        compared in constant time with JOB_TRIGGER_SECRET (at least 32 characters) — kept for local
//        and manual runs — OR a GOOGLE-SIGNED OIDC ID token (`Authorization: Bearer`), verified against
//        Google's keys with aud = JOB_TRIGGER_OIDC_AUDIENCE, a Google issuer and, when
//        JOB_TRIGGER_OIDC_SERVICE_ACCOUNT is set, that service account (M4.5 W5, services/jobs/oidc.ts).
//        Neither valid — or neither configured — is a bare 404, so the endpoint never confirms
//        itself (the M-Pesa webhook's rule); a SESSION token is neither and is 404 too.
//        `idempotency-key` (optional) makes a re-delivery a no-op; without it the key is the job and
//        the minute. On the WEBHOOK rate tier.
//   POST /v1/jobs/{name}/run             THE CONSOLE RUN (M4.5 W5): a SUPER_ADMIN session, after an
//        MFA step-up, with a REQUIRED `idempotency-key` — the SAME runner (lock, retries, record),
//        recorded trigger CONSOLE with the administrator. The machine secret never reaches a browser.
//   GET  /v1/jobs, /v1/jobs/runs         the read API (SUPER_ADMIN, PROGRAM_OFFICER): every job with
//        its last run, and the run history.
// ===========================================================================

import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { RATE_LIMITS } from "../plugins/security";
import { oidcPolicy, verifyGoogleIdToken } from "../services/jobs/oidc";
import { listJobRuns, listJobs, minuteKey, runJob, UnknownJobError } from "../services/jobs/runner";
import { errorResponses, notFound, SECURE, zTimestamp, zTimestampNullable } from "../schemas/common";

const zJobRun = z
  .object({
    id: z.string(),
    jobName: z.string(),
    trigger: z.string(),
    idempotencyKey: z.string(),
    requestedBy: z.string().nullable().meta({ description: "The administrator who started a CONSOLE run; null otherwise." }),
    status: z.enum(["RUNNING", "SUCCEEDED", "FAILED", "SKIPPED"]),
    attempts: z.number().int(),
    summary: z.record(z.string(), z.number()).nullable().meta({ description: "What the run did, as counts (e.g. timedOut, frozen, signed)." }),
    error: z.string().nullable(),
    startedAt: zTimestamp,
    finishedAt: zTimestampNullable,
  })
  .meta({ id: "JobRun" });

type RunRow = Awaited<ReturnType<typeof runJob>>;
const runView = (run: RunRow) => ({
  ...run,
  status: run.status as "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED",
  summary: run.summary !== null && typeof run.summary === "object" && !Array.isArray(run.summary) ? (run.summary as Record<string, number>) : null,
});

/** The configured secret, or null when the trigger is switched off (unset or too short to trust). */
export function jobTriggerSecret(): string | null {
  const raw = process.env.JOB_TRIGGER_SECRET;
  return raw !== undefined && raw.length >= 32 ? raw : null;
}

function secretMatches(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function jobTriggerRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  api.route({
    method: "POST",
    url: "/jobs/:name/run",
    config: { rateLimit: RATE_LIMITS.WEBHOOK },
    // Authorised BEFORE the params are validated: a caller without a credential learns nothing.
    preValidation: async (request, reply) => {
      if (!(await machineAuthorised(request.headers))) return reply.code(404).send(notFound("Not found."));
      return undefined;
    },
    schema: {
      tags: ["Scheduler"],
      summary: "Run a maintenance job (Cloud Scheduler)",
      description:
        "Authorised ONLY by the `x-job-trigger-secret` header (constant-time compared with JOB_TRIGGER_SECRET) or a Google-signed OIDC ID token as `Authorization: Bearer` (audience JOB_TRIGGER_OIDC_AUDIENCE, a Google issuer, and the configured service account); otherwise — or when neither is configured — a bare 404. Runs the job under its lock with bounded retries and records the run; the same `idempotency-key` twice returns the first run and runs nothing again.",
      params: z.object({ name: z.string().min(1).max(60) }),
      headers: z.looseObject({ "idempotency-key": z.string().min(1).max(200).optional() }),
      response: { 200: zJobRun, ...errorResponses(404, 429) },
    },
    handler: async (request, reply) => {
      const key = request.headers["idempotency-key"] ?? `${request.params.name}:${minuteKey(new Date())}`;
      try {
        return reply.code(200).send(runView(await runJob(request.params.name, "SCHEDULER", key)));
      } catch (error) {
        if (error instanceof UnknownJobError) return reply.code(404).send(notFound("Not found."));
        throw error;
      }
    },
  });
}

/**
 * Either machine credential: the shared secret (constant-time) or a Google-signed OIDC token. A
 * session's access token is a JWT too, but not Google-signed, so it fails the signature check.
 */
async function machineAuthorised(headers: Record<string, string | string[] | undefined>): Promise<boolean> {
  const secret = jobTriggerSecret();
  const given = headers["x-job-trigger-secret"];
  if (secret !== null && secretMatches(typeof given === "string" ? given : undefined, secret)) return true;
  const policy = oidcPolicy();
  const authorization = headers.authorization;
  if (policy === null || typeof authorization !== "string" || !/^Bearer [A-Za-z0-9._-]+$/.test(authorization)) return false;
  return verifyGoogleIdToken(authorization.slice("Bearer ".length), policy);
}

export async function jobReadRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const staff = [app.requireAuth, app.requireRole("SUPER_ADMIN", "PROGRAM_OFFICER")];

  api.route({
    method: "POST",
    url: "/:name/run",
    preHandler: [app.requireAuth, app.requireRole("SUPER_ADMIN"), app.requireStepUp],
    config: { rateLimit: RATE_LIMITS.SENSITIVE },
    schema: {
      tags: ["Scheduler"],
      summary: "Run a maintenance job from the Command Center (SUPER_ADMIN, after an MFA step-up)",
      description:
        "The SAME runner as the scheduler — the job's lock, bounded retries and a recorded run — recorded trigger CONSOLE with the administrator. `idempotency-key` is REQUIRED: the console sends one per click, so a repeated request returns the first run and runs nothing again. 403 StepUpRequired without a fresh step-up.",
      security: SECURE,
      params: z.object({ name: z.string().min(1).max(60) }),
      headers: z.looseObject({ "idempotency-key": z.string().min(8).max(200) }),
      response: { 200: zJobRun, ...errorResponses(400, 401, 403, 404, 429) },
    },
    handler: async (request, reply) => {
      const actor = request.auth?.userId ?? "";
      try {
        return reply.code(200).send(runView(await runJob(request.params.name, "CONSOLE", `console:${request.headers["idempotency-key"]}`, new Date(), actor)));
      } catch (error) {
        if (error instanceof UnknownJobError) return reply.code(404).send(notFound(error.message));
        throw error;
      }
    },
  });

  api.route({
    method: "GET",
    url: "/",
    preHandler: staff,
    schema: {
      tags: ["Scheduler"],
      summary: "Every maintenance job, with its suggested schedule and its last run",
      security: SECURE,
      response: { 200: z.object({ data: z.array(z.object({ name: z.string(), description: z.string(), suggestedSchedule: z.string(), lastRun: zJobRun.nullable() })) }), ...errorResponses(401, 403) },
    },
    handler: async (_request, reply) => {
      const jobs = await listJobs();
      return reply.code(200).send({ data: jobs.map((job) => ({ ...job, lastRun: job.lastRun === null ? null : runView(job.lastRun) })) });
    },
  });

  api.route({
    method: "GET",
    url: "/runs",
    preHandler: staff,
    schema: {
      tags: ["Scheduler"],
      summary: "The run history, newest first",
      security: SECURE,
      querystring: z.object({
        jobName: z.string().min(1).max(60).optional(),
        status: z.enum(["RUNNING", "SUCCEEDED", "FAILED", "SKIPPED"]).optional(),
        take: z.coerce.number().int().min(1).max(200).default(50),
        skip: z.coerce.number().int().min(0).default(0),
      }),
      response: { 200: z.object({ data: z.array(zJobRun), total: z.number().int() }), ...errorResponses(400, 401, 403) },
    },
    handler: async (request, reply) => {
      const result = await listJobRuns(request.query);
      return reply.code(200).send({ data: result.data.map(runView), total: result.total });
    },
  });
}
