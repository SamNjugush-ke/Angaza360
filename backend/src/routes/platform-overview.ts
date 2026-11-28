// ===========================================================================
// GET /v1/platform-reports/overview — the Command Center's executive overview (M4.5 Wave 5).
//
// SUPER_ADMIN and PROGRAM_OFFICER. Platform data only, bounded queries only — see
// src/services/platform/overview.ts. A static path, so it is matched before the report library's
// GET /v1/platform-reports/{id}.
// ===========================================================================

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { RATE_LIMITS } from "../plugins/security";
import { errorResponses, SECURE, zTimestamp } from "../schemas/common";
import { buildPlatformOverview } from "../services/platform/overview";

const zCounts = z.record(z.string(), z.number().int());

const zOverview = z.object({
  generatedAt: zTimestamp,
  businesses: z.object({ total: z.number().int(), byStatus: zCounts, byTier: zCounts }),
  applications: z.object({
    byStatus: zCounts.meta({ description: "Every application but drafts, by status." }),
    open: z.number().int().meta({ description: "SUBMITTED + UNDER_REVIEW + NEEDS_CHANGES." }),
    awaitingStaff: z.number().int().meta({ description: "SUBMITTED + UNDER_REVIEW — waiting on platform staff." }),
    oldestAwaitingSince: zTimestamp.nullable(),
    oldestAwaitingDays: z.number().int().nullable(),
  }),
  users: z.object({ activeAccounts: z.number().int(), inactiveAccounts: z.number().int(), signedInLast30Days: z.number().int(), platformStaff: z.number().int() }),
  integrations: z.object({
    businesses: z.array(z.object({ provider: z.string(), healthy: z.number().int(), failing: z.number().int() })).meta({ description: "Each business's last verify, from the health mirror (no credential is read)." }),
    platform: z.array(z.object({ provider: z.string(), environment: z.string(), status: z.string(), healthStatus: z.string(), lastHealthCheckAt: zTimestamp.nullable() })).meta({ description: "Angaza's own notification credentials — status only." }),
  }),
  jobs: z.object({
    failedLast24h: z.number().int(),
    list: z.array(z.object({ name: z.string(), suggestedSchedule: z.string(), lastStatus: z.string().nullable(), lastStartedAt: zTimestamp.nullable(), lastError: z.string().nullable(), failedLast24h: z.number().int() })),
  }),
  recentActivity: z.array(
    z.object({
      id: z.string(),
      action: z.string(),
      actorUserId: z.string().nullable(),
      targetUserId: z.string().nullable(),
      tenantId: z.string().nullable(),
      metadata: z.unknown(),
      occurredAt: zTimestamp,
      actorName: z.string().nullable(),
      targetName: z.string().nullable(),
    }),
  ),
});

export async function platformOverviewRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  api.route({
    method: "GET",
    url: "/overview",
    preHandler: [app.requireAuth, app.requireRole("SUPER_ADMIN", "PROGRAM_OFFICER")],
    config: { rateLimit: RATE_LIMITS.SENSITIVE },
    schema: {
      tags: ["Platform reports"],
      summary: "The Command Center's executive overview (platform data only)",
      description:
        "Businesses by status and plan; the applications pipeline (open, waiting on staff, the oldest waiting); accounts and sign-ins in the last 30 days; business integration health (from the health mirror) and Angaza's own notification credentials (status only); each job's last run and failures in the last 24 hours; and the ten newest identity-audit events. No business's books are read.",
      security: SECURE,
      response: { 200: zOverview, ...errorResponses(401, 403, 429) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      const role = auth?.role === "SUPER_ADMIN" ? "SUPER_ADMIN" : "PROGRAM_OFFICER";
      return reply.code(200).send(await buildPlatformOverview({ userId: auth?.userId ?? "", role, ipAddress: request.ip }));
    },
  });
}
