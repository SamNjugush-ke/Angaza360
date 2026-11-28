// ===========================================================================
// Support-access routes, mounted at /v1/support-access (M4.5 Wave 1 → standing god-mode, Wave 5).
//
// THE GRANT MODEL IS GONE. A SUPER_ADMIN no longer requests a time-bounded, owner-notified,
// owner-revocable grant to reach a business: they have STANDING god-mode and act as any active
// business by sending the act-as header (see src/plugins/auth.ts), operating THROUGH the existing
// tenant routes. So there is nothing here to create, scope, expire or revoke.
//
// What remains is the OWNER'S TRANSPARENCY SURFACE, repurposed: an owner reads every operator action
// on their OWN business — attributed to "Platform operator", never a named individual. The owner
// cannot approve or block an operator (that is the standing-access decision), but always has a
// truthful record that one acted and what they did. The same actions are in the internal platform
// audit log (GET /v1/users/audit) with the operator's real identity, for platform staff.
// ===========================================================================

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { listOperatorActivity } from "../services/identity/user-management";
import { errorResponses, SECURE, unauthorized, zTimestamp } from "../schemas/common";

const zActivity = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      at: zTimestamp,
      method: z.string().meta({ description: "The HTTP method of the operator's action." }),
      route: z.string().meta({ description: "The route template (no ids, no data) — WHAT was done." }),
      by: z.literal("Platform operator").meta({ description: "A standing operator acted; the individual is never named to the owner." }),
    }),
  ),
});

export async function supportAccessRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  // The owner's transparency surface: operator actions on their own business. The business is the
  // SESSION's own tenant — never named in the request — and MSME_OWNER only.
  api.route({
    method: "GET",
    url: "/my-business",
    preHandler: [app.requireAuth, app.requireTenant, app.requireRole("MSME_OWNER")],
    schema: {
      tags: ["Support"],
      summary: "Platform-operator actions on your business",
      description:
        "Every standing-operator (platform) action on your business, newest first — what was done and when, attributed to the platform operator. There is nothing to approve or revoke; this is your record that an operator acted.",
      security: SECURE,
      querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }),
      response: { 200: zActivity, ...errorResponses(401, 403) },
    },
    handler: async (request, reply) => {
      const tenantId = request.auth?.tenantId;
      if (tenantId === undefined || tenantId === null) return reply.code(401).send(unauthorized("Authentication required."));
      const entries = await listOperatorActivity(tenantId, request.query.limit);
      return reply.code(200).send({ data: entries.map((e) => ({ ...e, by: "Platform operator" as const })) });
    },
  });
}
