// ===========================================================================
// Mentorship routes (Module 14, Tasks 14.1, 14.2 and 14.3).
//
// These routes authorise and delegate. No route accepts a tenant or schema: a
// mentor's view of a business is resolved by src/services/mentorship/access.ts from an
// ACTIVE engagement, and an owner's actions are scoped to the business on their
// session. Engagement ids a caller may not see are answered 404, never 403, so the API
// never reveals which relationships exist.
// ===========================================================================

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  consentToEngagement,
  createEngagement,
  declineEngagement,
  endEngagement,
  listAccessLog,
  listEngagements,
  MentorshipNotFoundError,
  MentorshipStateError,
  MentorshipValidationError,
  type MentorshipActor,
} from "../services/mentorship/engagements";
import { buildMentorSnapshot } from "../services/mentorship/snapshot";
import {
  computeIndicatorActual,
  createActionItem,
  createGoal,
  createIndicator,
  createSession,
  getSession,
  listActionItems,
  listGoals,
  listIndicators,
  listSessions,
  completeOwnActionItem,
  MentorshipForbiddenError,
  updateActionItem,
  updateGoal,
} from "../services/mentorship/coaching";
import {
  buildCohort,
  buildEngagementDashboard,
  getMyEngagementView,
  listMyEngagements,
} from "../services/mentorship/dashboard";
import {
  zActionItemStatus,
  zActionParty,
  zGoalStatus,
  zIndicatorSourceKey,
  zMentorSnapshot,
  zMentorshipAccessLogEntry,
  zMentorshipActionItem,
  zMentorshipEngagement,
  zMentorshipGoal,
  zMentorshipIndicator,
  zMentorshipIndicatorActual,
  zMentorshipSession,
  zMentorCohort,
  zMentorshipDashboard,
  zOwnerEngagementView,
} from "../schemas/models";
import {
  badRequest,
  conflict,
  errorResponses,
  forbidden,
  isoDateToUtc,
  notFound,
  SECURE,
  unauthorized,
  zIdParam,
  zIsoDate,
  zMoney,
} from "../schemas/common";
import { parseMoneyToCents } from "../lib/money";

function sendMentorshipError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof MentorshipNotFoundError) {
    return reply.code(404).send(notFound(error.message));
  }
  if (error instanceof MentorshipStateError) {
    return reply.code(409).send(conflict(error.message));
  }
  if (error instanceof MentorshipForbiddenError) {
    return reply.code(403).send(forbidden(error.message));
  }
  if (error instanceof MentorshipValidationError) {
    return reply.code(400).send(badRequest(error.message));
  }
  throw error;
}

/** A validated YYYY-MM-DD (or null / absent) as the UTC date the column stores. */
function dateOrNull(value: string | null | undefined): Date | null | undefined {
  if (value === undefined || value === null) return value;
  return isoDateToUtc(value) ?? undefined;
}

function centsOrNull(value: string | null | undefined): bigint | null | undefined {
  if (value === undefined || value === null) return value;
  return parseMoneyToCents(value);
}

/** A KPI target rate: a decimal string, at most 7 integer digits and 2 places (Decimal(9,2)). */
const zTargetRate = z
  .string()
  .regex(/^-?\d{1,7}(\.\d{1,2})?$/, 'must be a decimal string with at most 2 places, e.g. "35.00".')
  .meta({ type: "string", examples: ["35.00"], description: "A ratio target as a decimal string (percent points, or times for INVENTORY_TURNOVER). Never a JSON number." });

const zText = z.string().max(4000);
const zOptionalText = zText.nullable().optional();

/** The caller, from the verified session only. */
function actorOf(request: FastifyRequest): MentorshipActor | null {
  const auth = request.auth;
  return auth === null ? null : { userId: auth.userId, role: auth.role, tenantId: auth.tenantId };
}

export async function mentorshipRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  // requireAuth only — NOT requireTenant: mentors and admins belong to no business.
  const base = [app.requireAuth];
  const adminRoles = app.requireRole("SUPER_ADMIN", "PROGRAM_OFFICER");
  const partyRoles = app.requireRole("SUPER_ADMIN", "PROGRAM_OFFICER", "MENTOR", "COACH", "MSME_OWNER");
  const ownerOnly = app.requireRole("MSME_OWNER");
  const mentorRoles = app.requireRole("MENTOR", "COACH");

  const notAuthenticated = (reply: FastifyReply): FastifyReply =>
    reply.code(401).send(unauthorized("Authentication required."));

  api.route({
    method: "POST",
    url: "/engagements",
    preHandler: [...base, adminRoles],
    schema: {
      tags: ["Mentorship"],
      summary: "Invite a mentor to a business (SUPER_ADMIN / PROGRAM_OFFICER)",
      description:
        "Creates an INVITED engagement. **It grants nothing**: the mentor has no access to the business until its MSME_OWNER consents. The mentor must be an active platform user (no business) with the MENTOR or COACH role. 409 if this mentor already has a live (INVITED or ACTIVE) engagement with this business.",
      security: SECURE,
      body: z.object({ mentorId: z.string().min(1), tenantId: z.string().min(1) }),
      response: { 201: zMentorshipEngagement, ...errorResponses(400, 401, 403, 409) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return notAuthenticated(reply);
      try {
        return reply.code(201).send(await createEngagement(actor, request.body));
      } catch (error) {
        return sendMentorshipError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/engagements",
    preHandler: [...base, partyRoles],
    schema: {
      tags: ["Mentorship"],
      summary: "Engagements visible to the caller",
      description: "A MENTOR or COACH sees their own; an MSME_OWNER sees the engagements on their own business; an admin sees all.",
      security: SECURE,
      response: { 200: z.object({ data: z.array(zMentorshipEngagement), count: z.number().int() }), ...errorResponses(401, 403) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return notAuthenticated(reply);
      const data = await listEngagements(actor);
      return reply.code(200).send({ data, count: data.length });
    },
  });

  api.route({
    method: "POST",
    url: "/engagements/:id/consent",
    preHandler: [...base, ownerOnly],
    schema: {
      tags: ["Mentorship"],
      summary: "Consent to a mentor reading this business's figures (MSME_OWNER)",
      description:
        "Moves an INVITED engagement on the caller's OWN business to ACTIVE and stamps who consented and when. From that moment the mentor may read this business's figures — read-only, and every read logged. 404 for an engagement on any other business; 409 if not INVITED.",
      security: SECURE,
      params: zIdParam,
      response: { 200: zMentorshipEngagement, ...errorResponses(401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return notAuthenticated(reply);
      try {
        return reply.code(200).send(await consentToEngagement(actor, request.params.id));
      } catch (error) {
        return sendMentorshipError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/engagements/:id/decline",
    preHandler: [...base, ownerOnly],
    schema: {
      tags: ["Mentorship"],
      summary: "Decline a mentor invitation (MSME_OWNER)",
      description: "Ends an INVITED engagement on the caller's own business. The mentor never gains access.",
      security: SECURE,
      params: zIdParam,
      response: { 200: zMentorshipEngagement, ...errorResponses(401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return notAuthenticated(reply);
      try {
        return reply.code(200).send(await declineEngagement(actor, request.params.id));
      } catch (error) {
        return sendMentorshipError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/engagements/:id/end",
    preHandler: [...base, partyRoles],
    schema: {
      tags: ["Mentorship"],
      summary: "End an engagement (the mentor, the business owner, or an admin)",
      description: "Access stops immediately — the gate admits only ACTIVE engagements. Terminal: re-engaging is a new invitation and a new consent.",
      security: SECURE,
      params: zIdParam,
      body: z.object({ reason: z.string().trim().min(1).optional() }),
      response: { 200: zMentorshipEngagement, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return notAuthenticated(reply);
      try {
        return reply.code(200).send(await endEngagement(actor, request.params.id, request.body.reason));
      } catch (error) {
        return sendMentorshipError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/engagements/:id/access-log",
    preHandler: [...base, partyRoles],
    schema: {
      tags: ["Mentorship"],
      summary: "Who read this business's data under an engagement, and when",
      description: "The business owner sees every read of their business; a mentor sees their own reads; an admin sees all. The log is append-only.",
      security: SECURE,
      params: zIdParam,
      response: { 200: z.object({ data: z.array(zMentorshipAccessLogEntry), count: z.number().int() }), ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return notAuthenticated(reply);
      try {
        const data = await listAccessLog(actor, request.params.id);
        return reply.code(200).send({ data, count: data.length });
      } catch (error) {
        return sendMentorshipError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/engagements/:id/snapshot",
    preHandler: [...base, mentorRoles],
    schema: {
      tags: ["Mentorship"],
      summary: "The engaged business's month-to-date snapshot (MENTOR / COACH)",
      description:
        "Read through the access gate: ONLY for an ACTIVE engagement of the calling mentor, otherwise 404 (no engagement, someone else's, unconsented, or ended — indistinguishable). The business is resolved from the engagement, never the request; the figures come from the Module 13 engine inside a READ ONLY transaction; the read is logged for the owner.",
      security: SECURE,
      params: zIdParam,
      response: { 200: zMentorSnapshot, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return notAuthenticated(reply);
      try {
        return reply.code(200).send(await buildMentorSnapshot(actor.userId, request.params.id));
      } catch (error) {
        return sendMentorshipError(reply, error);
      }
    },
  });

  // -------------------------------------------------------------------------
  // Task 14.2 — goals, indicators, action items, sessions. MENTOR / COACH only, on
  // their OWN engagement (anything else is 404). Writes need it ACTIVE (409 otherwise);
  // reads work on an ENDED engagement as history. Nothing here writes a tenant schema.
  // -------------------------------------------------------------------------

  const writeNote =
    " Only the engagement's own MENTOR/COACH; 404 for any other engagement; 409 unless the engagement is ACTIVE (an ended engagement's records are read-only history). Platform tables only — the business's books are never written.";
  const readNote = " Only the engagement's own MENTOR/COACH (404 otherwise). Works on an ENDED engagement: its records remain readable history.";

  api.route({
    method: "POST",
    url: "/engagements/:id/goals",
    preHandler: [...base, mentorRoles],
    schema: {
      tags: ["Mentorship"],
      summary: "Agree a goal (MENTOR / COACH)",
      description: "Creates an OPEN goal on the engagement." + writeNote,
      security: SECURE,
      params: zIdParam,
      body: z.object({
        title: zText.min(1),
        description: zOptionalText,
        targetValue: zMoney.nullable().optional(),
        targetMetric: zOptionalText,
        targetDate: zIsoDate.nullable().optional(),
      }),
      response: { 201: zMentorshipGoal, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return notAuthenticated(reply);
      const b = request.body;
      try {
        const goal = await createGoal(actor, request.params.id, {
          title: b.title,
          description: b.description,
          targetValue: centsOrNull(b.targetValue),
          targetMetric: b.targetMetric,
          targetDate: dateOrNull(b.targetDate),
        });
        return reply.code(201).send(goal);
      } catch (error) {
        return sendMentorshipError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/engagements/:id/goals",
    preHandler: [...base, mentorRoles],
    schema: {
      tags: ["Mentorship"],
      summary: "The engagement's goals (MENTOR / COACH)",
      description: "Oldest first." + readNote,
      security: SECURE,
      params: zIdParam,
      response: { 200: z.object({ data: z.array(zMentorshipGoal), count: z.number().int() }), ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return notAuthenticated(reply);
      try {
        const data = await listGoals(actor, request.params.id);
        return reply.code(200).send({ data, count: data.length });
      } catch (error) {
        return sendMentorshipError(reply, error);
      }
    },
  });

  api.route({
    method: "PATCH",
    url: "/goals/:id",
    preHandler: [...base, mentorRoles],
    schema: {
      tags: ["Mentorship"],
      summary: "Update a goal or its status (MENTOR / COACH)",
      description:
        "OPEN / ON_TRACK / AT_RISK may move freely; MET and MISSED are final (409 on any later change). Omitted fields are unchanged; null clears an optional field." +
        writeNote,
      security: SECURE,
      params: zIdParam,
      body: z.object({
        title: zText.min(1).optional(),
        description: zOptionalText,
        targetValue: zMoney.nullable().optional(),
        targetMetric: zOptionalText,
        targetDate: zIsoDate.nullable().optional(),
        status: zGoalStatus.optional(),
      }),
      response: { 200: zMentorshipGoal, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return notAuthenticated(reply);
      const b = request.body;
      try {
        const goal = await updateGoal(actor, request.params.id, {
          title: b.title,
          description: b.description,
          targetValue: centsOrNull(b.targetValue),
          targetMetric: b.targetMetric,
          targetDate: dateOrNull(b.targetDate),
          status: b.status,
        });
        return reply.code(200).send(goal);
      } catch (error) {
        return sendMentorshipError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/engagements/:id/indicators",
    preHandler: [...base, mentorRoles],
    schema: {
      tags: ["Mentorship"],
      summary: "Agree a KPI and its target (MENTOR / COACH)",
      description:
        "A MONEY indicator (MONTHLY_REVENUE, NET_PROFIT, CASH_POSITION, RECEIVABLES_OUTSTANDING) takes targetAmount (KES decimal string) and no targetRate; a RATE indicator (GROSS_MARGIN_PCT, SALES_GROWTH_PCT, INVENTORY_TURNOVER) takes targetRate and no targetAmount — 400 otherwise, and a database CHECK backs it. Only NET_PROFIT and SALES_GROWTH_PCT targets may be negative. The ACTUAL is never stored." +
        writeNote,
      security: SECURE,
      params: zIdParam,
      body: z.object({
        name: zText.min(1),
        sourceKey: zIndicatorSourceKey,
        targetAmount: zMoney.nullable().optional(),
        targetRate: zTargetRate.nullable().optional(),
        note: zOptionalText,
      }),
      response: { 201: zMentorshipIndicator, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return notAuthenticated(reply);
      const b = request.body;
      try {
        const indicator = await createIndicator(actor, request.params.id, {
          name: b.name,
          sourceKey: b.sourceKey,
          targetAmount: centsOrNull(b.targetAmount),
          targetRate: b.targetRate,
          note: b.note,
        });
        return reply.code(201).send(indicator);
      } catch (error) {
        return sendMentorshipError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/engagements/:id/indicators",
    preHandler: [...base, mentorRoles],
    schema: {
      tags: ["Mentorship"],
      summary: "The engagement's agreed KPIs and targets (MENTOR / COACH)",
      description: "Targets only; read each actual from /indicators/{id}/actual." + readNote,
      security: SECURE,
      params: zIdParam,
      response: { 200: z.object({ data: z.array(zMentorshipIndicator), count: z.number().int() }), ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return notAuthenticated(reply);
      try {
        const data = await listIndicators(actor, request.params.id);
        return reply.code(200).send({ data, count: data.length });
      } catch (error) {
        return sendMentorshipError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/indicators/:id/actual",
    preHandler: [...base, mentorRoles],
    schema: {
      tags: ["Mentorship"],
      summary: "A KPI's actual, computed live (MENTOR / COACH)",
      description:
        "Computed NOW from the engaged business's books by the Module 13 engine, through the read-only access gate, and LOGGED for the owner — never stored. Current month to date for flows; today for balances. A ratio with a zero denominator returns actualRate null with unavailableReason. 404 unless the engagement is this mentor's and ACTIVE (an ended engagement no longer opens the books).",
      security: SECURE,
      params: zIdParam,
      response: { 200: zMentorshipIndicatorActual, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return notAuthenticated(reply);
      try {
        return reply.code(200).send(await computeIndicatorActual(actor, request.params.id));
      } catch (error) {
        return sendMentorshipError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/engagements/:id/action-items",
    preHandler: [...base, mentorRoles],
    schema: {
      tags: ["Mentorship"],
      summary: "Add an action item (MENTOR / COACH)",
      description: "Creates an OPEN action owned by the MENTOR or the ENTREPRENEUR." + writeNote,
      security: SECURE,
      params: zIdParam,
      body: z.object({
        title: zText.min(1),
        description: zOptionalText,
        responsibleParty: zActionParty,
        dueDate: zIsoDate.nullable().optional(),
      }),
      response: { 201: zMentorshipActionItem, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return notAuthenticated(reply);
      const b = request.body;
      try {
        const item = await createActionItem(actor, request.params.id, {
          title: b.title,
          description: b.description,
          responsibleParty: b.responsibleParty,
          dueDate: dateOrNull(b.dueDate),
        });
        return reply.code(201).send(item);
      } catch (error) {
        return sendMentorshipError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/engagements/:id/action-items",
    preHandler: [...base, mentorRoles],
    schema: {
      tags: ["Mentorship"],
      summary: "The engagement's action plan (MENTOR / COACH)",
      description: "Oldest first." + readNote,
      security: SECURE,
      params: zIdParam,
      response: { 200: z.object({ data: z.array(zMentorshipActionItem), count: z.number().int() }), ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return notAuthenticated(reply);
      try {
        const data = await listActionItems(actor, request.params.id);
        return reply.code(200).send({ data, count: data.length });
      } catch (error) {
        return sendMentorshipError(reply, error);
      }
    },
  });

  api.route({
    method: "PATCH",
    url: "/action-items/:id",
    preHandler: [...base, mentorRoles],
    schema: {
      tags: ["Mentorship"],
      summary: "Update an action item or complete / cancel it (MENTOR / COACH)",
      description:
        "OPEN -> DONE (stamps completedAt) | CANCELLED; both final (409 on any later change). Omitted fields are unchanged; null clears an optional field." +
        writeNote,
      security: SECURE,
      params: zIdParam,
      body: z.object({
        title: zText.min(1).optional(),
        description: zOptionalText,
        responsibleParty: zActionParty.optional(),
        dueDate: zIsoDate.nullable().optional(),
        status: zActionItemStatus.optional(),
      }),
      response: { 200: zMentorshipActionItem, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return notAuthenticated(reply);
      const b = request.body;
      try {
        const item = await updateActionItem(actor, request.params.id, {
          title: b.title,
          description: b.description,
          responsibleParty: b.responsibleParty,
          dueDate: dateOrNull(b.dueDate),
          status: b.status,
        });
        return reply.code(200).send(item);
      } catch (error) {
        return sendMentorshipError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/engagements/:id/sessions",
    preHandler: [...base, mentorRoles],
    schema: {
      tags: ["Mentorship"],
      summary: "Record a coaching session (MENTOR / COACH)",
      description:
        "A dated check-in: summary, observations, commitments. Immutable once recorded — a correction is a new session. sessionDate may not be in the future (400)." +
        writeNote,
      security: SECURE,
      params: zIdParam,
      body: z.object({
        sessionDate: zIsoDate,
        summary: zText.min(1),
        observations: zOptionalText,
        commitments: zOptionalText,
      }),
      response: { 201: zMentorshipSession, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return notAuthenticated(reply);
      const b = request.body;
      const sessionDate = isoDateToUtc(b.sessionDate);
      if (sessionDate === null) return reply.code(400).send(badRequest("sessionDate must be YYYY-MM-DD."));
      try {
        const session = await createSession(actor, request.params.id, {
          sessionDate,
          summary: b.summary,
          observations: b.observations,
          commitments: b.commitments,
        });
        return reply.code(201).send(session);
      } catch (error) {
        return sendMentorshipError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/engagements/:id/sessions",
    preHandler: [...base, mentorRoles],
    schema: {
      tags: ["Mentorship"],
      summary: "The engagement's coaching sessions (MENTOR / COACH)",
      description: "Newest first." + readNote,
      security: SECURE,
      params: zIdParam,
      response: { 200: z.object({ data: z.array(zMentorshipSession), count: z.number().int() }), ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return notAuthenticated(reply);
      try {
        const data = await listSessions(actor, request.params.id);
        return reply.code(200).send({ data, count: data.length });
      } catch (error) {
        return sendMentorshipError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/sessions/:id",
    preHandler: [...base, mentorRoles],
    schema: {
      tags: ["Mentorship"],
      summary: "One coaching session (MENTOR / COACH)",
      description: readNote.trim(),
      security: SECURE,
      params: zIdParam,
      response: { 200: zMentorshipSession, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return notAuthenticated(reply);
      try {
        return reply.code(200).send(await getSession(actor, request.params.id));
      } catch (error) {
        return sendMentorshipError(reply, error);
      }
    },
  });

  // -------------------------------------------------------------------------
  // Task 14.3 — the composed mentor views and the entrepreneur's reciprocal view.
  // -------------------------------------------------------------------------

  api.route({
    method: "GET",
    url: "/engagements/:id/dashboard",
    preHandler: [...base, mentorRoles],
    schema: {
      tags: ["Mentorship"],
      summary: "One engagement, composed (MENTOR / COACH)",
      description:
        "The engagement and mentee, every agreed indicator's target against its LIVE actual and standing, goals, the action plan (open / closed) and the five most recent sessions. The actuals are computed by the Module 13 engine in ONE read-only gate opening, logged for the owner as one read naming the indicators. 404 unless this is the caller's ACTIVE engagement — an ended engagement's records are read through the individual lists.",
      security: SECURE,
      params: zIdParam,
      response: { 200: zMentorshipDashboard, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return notAuthenticated(reply);
      try {
        return reply.code(200).send(await buildEngagementDashboard(actor, request.params.id));
      } catch (error) {
        return sendMentorshipError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/cohort",
    preHandler: [...base, mentorRoles],
    schema: {
      tags: ["Mentorship"],
      summary: "The mentor's cohort with headline KPIs (MENTOR / COACH)",
      description:
        "Every ACTIVE engagement of the caller with month-to-date revenue, cash position and gross margin. This is the sanctioned cross-tenant roll-up: each business is read through its OWN gate call (its own schema, READ ONLY, its own logged read) and no figure is combined across businesses. ENDED engagements are not listed.",
      security: SECURE,
      response: { 200: zMentorCohort, ...errorResponses(401, 403) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return notAuthenticated(reply);
      return reply.code(200).send(await buildCohort(actor));
    },
  });

  api.route({
    method: "GET",
    url: "/my-engagements",
    preHandler: [...base, ownerOnly],
    schema: {
      tags: ["Mentorship"],
      summary: "Mentoring on my business (MSME_OWNER)",
      description: "Every engagement on the caller's own business, at any status: mentor, status, consent and dates.",
      security: SECURE,
      response: { 200: z.object({ data: z.array(zMentorshipEngagement), count: z.number().int() }), ...errorResponses(401, 403) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return notAuthenticated(reply);
      try {
        const data = await listMyEngagements(actor);
        return reply.code(200).send({ data, count: data.length });
      } catch (error) {
        return sendMentorshipError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/my-engagements/:id",
    preHandler: [...base, ownerOnly],
    schema: {
      tags: ["Mentorship"],
      summary: "One engagement on my business, in full (MSME_OWNER)",
      description:
        "The goals, indicator targets, action items and sessions the mentor set, and the access log of every read of the business's books — readable at any status, including after the engagement ends. 404 for an engagement on any other business.",
      security: SECURE,
      params: zIdParam,
      response: { 200: zOwnerEngagementView, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return notAuthenticated(reply);
      try {
        return reply.code(200).send(await getMyEngagementView(actor, request.params.id));
      } catch (error) {
        return sendMentorshipError(reply, error);
      }
    },
  });

  api.route({
    method: "PATCH",
    url: "/my-action-items/:id",
    preHandler: [...base, ownerOnly],
    schema: {
      tags: ["Mentorship"],
      summary: "Mark my action item DONE (MSME_OWNER)",
      description:
        "The entrepreneur's ONE write: an action item assigned to the ENTREPRENEUR, on an ACTIVE engagement with the caller's own business, goes OPEN -> DONE (completedAt and completedById stamped). 404 for an item on another business; 403 for an item assigned to the MENTOR; 409 if the engagement is not ACTIVE or the item is not OPEN. Nothing else about the item can change, and the business's books are not touched.",
      security: SECURE,
      params: zIdParam,
      body: z.object({ status: z.literal("DONE") }),
      response: { 200: zMentorshipActionItem, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return notAuthenticated(reply);
      try {
        return reply.code(200).send(await completeOwnActionItem(actor, request.params.id));
      } catch (error) {
        return sendMentorshipError(reply, error);
      }
    },
  });
}
