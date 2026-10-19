// ===========================================================================
// Donor projects / cohorts (Task T-A12), mounted at /v1/donor-projects.
//
// PLATFORM STAFF (SUPER_ADMIN, PROGRAM_OFFICER): create, list, read and close projects;
// add and remove member businesses; read the cohort AGGREGATE (every consented member read
// through the shared READ-ONLY, logged gate). A tenant user is refused on all of these.
//
// THE BUSINESS OWNER (MSME_OWNER): sees their own business's memberships, gives or
// withdraws consent, and reads the access log of every cohort read of their own books.
// Another business's membership is 404. No route takes a tenant id from a business user.
// ===========================================================================

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { RATE_LIMITS } from "../plugins/security";
import { badRequest, errorBody, errorResponses, isoDateToUtc, SECURE, unauthorized, zCentsString, zIsoDate, zTimestamp, zTimestampNullable } from "../schemas/common";
import type { Actor } from "../services/identity/user-management";
import { buildCohortAggregate } from "../services/donor/aggregate";
import {
  addMember,
  closeProject,
  createProject,
  DonorError,
  getProject,
  giveConsent,
  listOwnMemberships,
  listProjects,
  ownAccessLog,
  removeMember,
  withdrawConsent,
} from "../services/donor/projects";
import { ReportValidationError, resolvePeriod, type PeriodRequest } from "../services/reports";

const zProject = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  donor: z.string(),
  description: z.string().nullable(),
  status: z.enum(["ACTIVE", "CLOSED"]),
  createdById: z.string(),
  createdAt: zTimestamp,
  closedAt: zTimestampNullable,
});

const zMembership = z.object({
  id: z.string(),
  projectId: z.string(),
  tenantId: z.string(),
  businessName: z.string(),
  tenantStatus: z.enum(["PENDING_PROVISIONING", "ACTIVE", "SUSPENDED", "DEACTIVATED"]),
  consentStatus: z.enum(["PENDING", "CONSENTED", "WITHDRAWN"]),
  consentByUserId: z.string().nullable(),
  consentAt: zTimestampNullable,
  joinedAt: zTimestamp,
});

const zPeriod = z.object({ from: zTimestamp, to: zTimestamp });

const zAggregate = z.object({
  projectId: z.string(),
  code: z.string(),
  period: zPeriod,
  comparativePeriod: zPeriod.nullable(),
  members: z.object({
    total: z.number().int(),
    consented: z.number().int(),
    pending: z.number().int(),
    withdrawn: z.number().int(),
    consentedButInactive: z.number().int(),
  }),
  businessesIncluded: z.number().int(),
  totalRevenue: zCentsString,
  medianRevenue: zCentsString,
  totalNetProfit: zCentsString,
  revenueGrowthPct: z.string().nullable(),
  consentedMembers: z.array(
    z.object({ tenantId: z.string(), businessName: z.string(), revenue: zCentsString, comparativeRevenue: zCentsString, netProfit: zCentsString }),
  ),
});

const ERROR_NAMES = { 400: "BadRequest", 403: "Forbidden", 404: "NotFound", 409: "Conflict" } as const;

function sendDonorError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof DonorError) {
    return reply.code(error.status).send(errorBody(error.status, ERROR_NAMES[error.status], error.message));
  }
  if (error instanceof ReportValidationError) {
    return reply.code(400).send(badRequest(error.message));
  }
  throw error;
}

function actorOf(request: FastifyRequest): Actor | null {
  const auth = request.auth;
  return auth === null ? null : { userId: auth.userId, role: auth.role, tenantId: auth.tenantId, ipAddress: request.ip };
}

function toDate(value: string, field: string): Date {
  const date = isoDateToUtc(value);
  if (date === null) throw new ReportValidationError(`${field} must be YYYY-MM-DD.`);
  return date;
}

export async function donorProjectRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const staff = [app.requireAuth, app.requireRole("SUPER_ADMIN", "PROGRAM_OFFICER")];
  const owner = [app.requireAuth, app.requireTenant, app.requireRole("MSME_OWNER")];
  const zIdParams = z.object({ id: z.string().min(1) });

  api.route({
    method: "POST",
    url: "/",
    preHandler: staff,
    schema: {
      tags: ["Donor projects"],
      summary: "Create a donor project (cohort)",
      description: "Businesses whose registry donorProjectCode equals the code are enrolled at once, each PENDING its owner's consent.",
      security: SECURE,
      body: z.object({
        code: z.string().trim().min(2).max(40),
        name: z.string().trim().min(1).max(200),
        donor: z.string().trim().min(1).max(200),
        description: z.string().trim().min(1).max(2000).optional(),
      }),
      response: { 201: z.object({ project: zProject, seeded: z.number().int() }), ...errorResponses(400, 401, 403, 409) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
      try {
        const body = request.body;
        return reply.code(201).send(await createProject(actor, { code: body.code, name: body.name, donor: body.donor, description: body.description ?? null }));
      } catch (error) {
        return sendDonorError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/",
    preHandler: staff,
    schema: {
      tags: ["Donor projects"],
      summary: "List donor projects",
      security: SECURE,
      querystring: z.object({ status: z.enum(["ACTIVE", "CLOSED"]).optional() }),
      response: { 200: z.object({ data: z.array(zProject) }), ...errorResponses(400, 401, 403) },
    },
    handler: async (request, reply) => reply.code(200).send({ data: await listProjects({ status: request.query.status ?? null }) }),
  });

  // ---- The owner's side (static paths, registered before /:id) -------------------------

  api.route({
    method: "GET",
    url: "/my-memberships",
    preHandler: owner,
    schema: {
      tags: ["Donor projects"],
      summary: "The donor projects your business is a member of",
      security: SECURE,
      response: { 200: z.object({ data: z.array(z.object({ membership: zMembership, project: zProject })) }), ...errorResponses(401, 403) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
      try {
        return reply.code(200).send({ data: await listOwnMemberships(actor) });
      } catch (error) {
        return sendDonorError(reply, error);
      }
    },
  });

  for (const action of ["consent", "withdraw"] as const) {
    api.route({
      method: "POST",
      url: `/my-memberships/:id/${action}`,
      preHandler: owner,
      schema: {
        tags: ["Donor projects"],
        summary: action === "consent" ? "Consent to your business's figures being included in the cohort aggregate" : "Withdraw that consent",
        description:
          "Owner of THIS business only. While CONSENTED, platform staff may read the business's books for the cohort aggregate — read-only, and every read logged where you can see it. Withdrawal takes effect at once.",
        security: SECURE,
        params: zIdParams,
        response: { 200: zMembership, ...errorResponses(401, 403, 404, 409) },
      },
      handler: async (request, reply) => {
        const actor = actorOf(request);
        if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
        try {
          const run = action === "consent" ? giveConsent : withdrawConsent;
          return reply.code(200).send(await run(actor, request.params.id));
        } catch (error) {
          return sendDonorError(reply, error);
        }
      },
    });
  }

  api.route({
    method: "GET",
    url: "/my-memberships/:id/access-log",
    preHandler: owner,
    schema: {
      tags: ["Donor projects"],
      summary: "Every cohort read of your business's books",
      security: SECURE,
      params: zIdParams,
      response: {
        200: z.object({
          data: z.array(z.object({ id: z.string(), projectId: z.string(), readerUserId: z.string(), resource: z.string(), viewedAt: zTimestamp })),
        }),
        ...errorResponses(401, 403, 404),
      },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
      try {
        return reply.code(200).send({ data: await ownAccessLog(actor, request.params.id) });
      } catch (error) {
        return sendDonorError(reply, error);
      }
    },
  });

  // ---- One project ------------------------------------------------------------------------

  api.route({
    method: "GET",
    url: "/:id",
    preHandler: staff,
    schema: {
      tags: ["Donor projects"],
      summary: "A donor project and its members",
      security: SECURE,
      params: zIdParams,
      response: { 200: z.object({ project: zProject, members: z.array(zMembership) }), ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      try {
        return reply.code(200).send(await getProject(request.params.id));
      } catch (error) {
        return sendDonorError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/:id/close",
    preHandler: staff,
    schema: {
      tags: ["Donor projects"],
      summary: "Close a donor project (terminal)",
      description: "After closing, no member's books are read for the cohort and consent no longer changes.",
      security: SECURE,
      params: zIdParams,
      response: { 200: zProject, ...errorResponses(401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
      try {
        return reply.code(200).send(await closeProject(actor, request.params.id));
      } catch (error) {
        return sendDonorError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/:id/members",
    preHandler: staff,
    schema: {
      tags: ["Donor projects"],
      summary: "Add a business to the cohort (PENDING its owner's consent)",
      security: SECURE,
      params: zIdParams,
      body: z.object({ tenantId: z.string().min(1) }),
      response: { 201: zMembership, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
      try {
        return reply.code(201).send(await addMember(actor, request.params.id, request.body.tenantId));
      } catch (error) {
        return sendDonorError(reply, error);
      }
    },
  });

  api.route({
    method: "DELETE",
    url: "/:id/members/:tenantId",
    preHandler: staff,
    schema: {
      tags: ["Donor projects"],
      summary: "Remove a business from the cohort",
      security: SECURE,
      params: z.object({ id: z.string().min(1), tenantId: z.string().min(1) }),
      response: { 204: z.void().meta({ description: "Removed." }), ...errorResponses(401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
      try {
        await removeMember(actor, request.params.id, request.params.tenantId);
        return reply.code(204).send();
      } catch (error) {
        return sendDonorError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/:id/aggregate",
    config: { rateLimit: RATE_LIMITS.SENSITIVE },
    preHandler: staff,
    schema: {
      tags: ["Donor projects"],
      summary: "The cohort aggregate for a period",
      description:
        "Reads EACH CONSENTED member through the shared READ-ONLY gate (each read logged to the donor access log before its data is returned) and aggregates: businesses included, total and median revenue, total net profit, revenue growth against the preceding equal period. PENDING and WITHDRAWN members are counted, never read. Per-business figures are returned for consented members only. Period: from+to, year+month, year, or the current month to date.",
      security: SECURE,
      params: zIdParams,
      querystring: z.object({
        from: zIsoDate.optional(),
        to: zIsoDate.optional(),
        year: z.coerce.number().int().min(2000).max(2200).optional(),
        month: z.coerce.number().int().min(1).max(12).optional(),
      }),
      response: { 200: zAggregate, ...errorResponses(400, 401, 403, 404, 409, 429) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
      try {
        const q = request.query;
        const periodRequest: PeriodRequest = {
          ...(q.from !== undefined ? { from: toDate(q.from, "from") } : {}),
          ...(q.to !== undefined ? { to: toDate(q.to, "to") } : {}),
          ...(q.year !== undefined ? { year: q.year } : {}),
          ...(q.month !== undefined ? { month: q.month } : {}),
        };
        return reply.code(200).send(await buildCohortAggregate(actor, request.params.id, resolvePeriod(periodRequest)));
      } catch (error) {
        return sendDonorError(reply, error);
      }
    },
  });
}
