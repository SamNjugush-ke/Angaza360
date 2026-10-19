// ===========================================================================
// Tenant onboarding + lifecycle routes (Task T-A6.1), mounted at /v1/tenants.
//
// PLATFORM-SCOPED: SUPER_ADMIN and PROGRAM_OFFICER only; a tenant user is refused on
// every route. Onboarding itself — the step that provisions and invites the owner — is
// SUPER_ADMIN only (the T-A5 role-assignment rule); a PROGRAM_OFFICER validates, lists,
// reviews and runs the lifecycle.
//
// A candidate that is not GREEN is reported, never onboarded. /onboard/validate returns
// the structured report (status, field errors, proposed subdomain) and writes nothing;
// /onboard re-validates and answers 400 in the one error shape, naming every failing
// field, when the candidate is not GREEN.
// ===========================================================================

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { RATE_LIMITS } from "../plugins/security";
import { errorBody, errorResponses, SECURE, unauthorized, zTimestamp } from "../schemas/common";
import { zUserRole } from "../schemas/models";
import { UserManagementError, type Actor } from "../services/identity/user-management";
import { validateOnboardingCandidate } from "../services/tenants/candidate";
import { deactivateTenant, reactivateTenant, suspendTenant } from "../services/tenants/lifecycle";
import { onboardTenant } from "../services/tenants/onboarding";
import { getTenantView, listTenantViews, TenantAdminError } from "../services/tenants/tenant-view";

const zTenantStatus = z.enum(["PENDING_PROVISIONING", "ACTIVE", "SUSPENDED", "DEACTIVATED"]);

export const zTenantView = z.object({
  id: z.string(),
  name: z.string(),
  subdomain: z.string(),
  businessSector: z.string().nullable(),
  kraPin: z.string().nullable(),
  taxRegime: z.enum(["VAT", "TURNOVER_TAX", "EXEMPT"]),
  status: zTenantStatus,
  subscriptionTier: z.enum(["MWANZO", "UKUAJI", "BIASHARA", "MSTAWI", "ENTERPRISE"]),
  subscriptionStatus: z.enum(["TRIALING", "ACTIVE", "PAST_DUE", "GRACE_PERIOD", "SUSPENDED", "CANCELLED"]),
  createdAt: zTimestamp,
  updatedAt: zTimestamp,
});

/** The fields every onboarding path takes. Shape only: the green-gate judges the content. */
export const zOnboardingCandidate = z.object({
  businessName: z.string().max(400),
  subdomain: z.string().max(100).nullable().optional().meta({ description: "Optional; a free one is generated from the business name when absent." }),
  sector: z.string().max(200).nullable().optional(),
  kraPin: z.string().max(40).nullable().optional().meta({ description: "The business's KRA PIN, e.g. P051234567X. Unique." }),
  taxRegime: z.string().max(40).meta({ description: "VAT_REGISTERED, TURNOVER_TAX or EXEMPT. Written to the registry AND the new business's BusinessProfile." }),
  requestedTier: z.string().max(40).nullable().optional(),
  ownerFullName: z.string().max(400),
  ownerEmail: z.string().max(400),
  ownerPhone: z.string().max(40).nullable().optional(),
  ownerNationalId: z.string().max(40).nullable().optional().meta({ description: "Unique. Stored on the owner's user when they accept." }),
});

export const zCandidateError = z.object({
  field: z.string(),
  code: z.enum(["REQUIRED", "FORMAT", "DUPLICATE", "RESERVED"]),
  message: z.string(),
});

const zValidationReport = z.object({
  status: z.enum(["GREEN", "RED"]),
  errors: z.array(zCandidateError),
  proposedSubdomain: z.string().nullable(),
});

const zOwnerInvitation = z.object({
  invitation: z.object({
    id: z.string(),
    email: z.string(),
    role: zUserRole,
    tenantId: z.string().nullable(),
    status: z.enum(["PENDING", "ACCEPTED", "REVOKED", "EXPIRED"]),
    expiresAt: zTimestamp,
    createdAt: zTimestamp,
  }),
  delivery: z.object({
    email: z.enum(["QUEUED", "SENT", "FAILED", "SIMULATED"]),
    sms: z.enum(["QUEUED", "SENT", "FAILED", "SIMULATED"]).nullable(),
  }),
});

export const zOnboardedTenant = z.object({ tenant: zTenantView, ownerInvitation: zOwnerInvitation });

const zIdParams = z.object({ id: z.string().min(1) });
const zReasonBody = z.object({ reason: z.string().trim().min(1).max(500).optional() }).optional();

const ERROR_NAMES = { 400: "BadRequest", 403: "Forbidden", 404: "NotFound", 409: "Conflict" } as const;

export function sendTenantAdminError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof TenantAdminError || error instanceof UserManagementError) {
    return reply.code(error.status).send(errorBody(error.status, ERROR_NAMES[error.status], error.message));
  }
  throw error;
}

/** "field: message; field: message" — a RED report in the one error shape. */
export function redMessage(errors: ReadonlyArray<{ field: string; message: string }>): string {
  return `The business cannot be onboarded until every field is green: ${errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`;
}

export function actorOf(request: FastifyRequest): Actor | null {
  const auth = request.auth;
  return auth === null ? null : { userId: auth.userId, role: auth.role, tenantId: auth.tenantId, ipAddress: request.ip };
}

export async function tenantRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const platformStaff = [app.requireAuth, app.requireRole("SUPER_ADMIN", "PROGRAM_OFFICER")];

  api.route({
    method: "POST",
    url: "/onboard/validate",
    preHandler: platformStaff,
    schema: {
      tags: ["Tenants"],
      summary: "Preview an onboarding: the green-gate report and the proposed subdomain",
      description:
        "Runs the green-gate and proposes a subdomain. WRITES NOTHING. GREEN means the business may be onboarded as it stands; RED lists every failing field (a duplicate business name, KRA PIN, owner National ID, owner email or subdomain; a missing or malformed field).",
      security: SECURE,
      body: zOnboardingCandidate,
      response: { 200: zValidationReport, ...errorResponses(400, 401, 403) },
    },
    handler: async (request, reply) => {
      const report = await validateOnboardingCandidate(request.body);
      return reply.code(200).send({ status: report.status, errors: [...report.errors], proposedSubdomain: report.proposedSubdomain });
    },
  });

  api.route({
    method: "POST",
    url: "/onboard",
    config: { rateLimit: RATE_LIMITS.SENSITIVE },
    preHandler: [app.requireAuth, app.requireRole("SUPER_ADMIN")],
    schema: {
      tags: ["Tenants"],
      summary: "Onboard a business: provision it and invite its first owner",
      description:
        "SUPER_ADMIN only. Re-runs the green-gate; when GREEN, provisions the tenant (every tenant migration, chart, statutory seed, MAIN location), records the declared tax regime on the registry and the new BusinessProfile, invites the owner as MSME_OWNER and audits TENANT_ONBOARDED. When not GREEN, nothing is provisioned and nobody is invited: 400 naming every failing field.",
      security: SECURE,
      body: zOnboardingCandidate,
      response: { 201: zOnboardedTenant, ...errorResponses(400, 401, 403, 409, 429) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
      try {
        const outcome = await onboardTenant(actor, request.body);
        if (outcome.status === "RED") {
          return reply.code(400).send(errorBody(400, "BadRequest", redMessage(outcome.errors)));
        }
        return reply.code(201).send(outcome.onboarded);
      } catch (error) {
        return sendTenantAdminError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/",
    preHandler: platformStaff,
    schema: {
      tags: ["Tenants"],
      summary: "List tenants",
      security: SECURE,
      querystring: z.object({ status: zTenantStatus.optional() }),
      response: { 200: z.object({ data: z.array(zTenantView) }), ...errorResponses(400, 401, 403) },
    },
    handler: async (request, reply) => {
      const data = await listTenantViews({ status: request.query.status ?? null });
      return reply.code(200).send({ data });
    },
  });

  api.route({
    method: "GET",
    url: "/:id",
    preHandler: platformStaff,
    schema: {
      tags: ["Tenants"],
      summary: "Get a tenant",
      security: SECURE,
      params: zIdParams,
      response: { 200: zTenantView, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      try {
        return reply.code(200).send(await getTenantView(request.params.id));
      } catch (error) {
        return sendTenantAdminError(reply, error);
      }
    },
  });

  const lifecycle = [
    { url: "/:id/suspend", run: suspendTenant, summary: "Suspend a tenant (ACTIVE -> SUSPENDED); its users are locked out" },
    { url: "/:id/reactivate", run: reactivateTenant, summary: "Reactivate a suspended tenant (SUSPENDED -> ACTIVE)" },
    { url: "/:id/deactivate", run: deactivateTenant, summary: "Deactivate a tenant (ACTIVE | SUSPENDED -> DEACTIVATED, terminal)" },
  ] as const;

  for (const action of lifecycle) {
    api.route({
      method: "POST",
      url: action.url,
      preHandler: platformStaff,
      schema: {
        tags: ["Tenants"],
        summary: action.summary,
        description:
          "Allowed moves: ACTIVE <-> SUSPENDED, ACTIVE | SUSPENDED -> DEACTIVATED (terminal). Any other is 409 — and refused by the database trigger for any writer. Audited. A non-ACTIVE tenant's users get 403 on login and on every request.",
        security: SECURE,
        params: zIdParams,
        body: zReasonBody,
        response: { 200: zTenantView, ...errorResponses(400, 401, 403, 404, 409) },
      },
      handler: async (request, reply) => {
        const actor = actorOf(request);
        if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
        try {
          return reply.code(200).send(await action.run(actor, request.params.id, request.body?.reason ?? null));
        } catch (error) {
          return sendTenantAdminError(reply, error);
        }
      },
    });
  }
}
