// ===========================================================================
// Public self-serve signup (Task T-A6.2), mounted at /v1/public.
//
// THE ONLY UNAUTHENTICATED ONBOARDING ROUTE. It creates a PENDING_APPROVAL application and
// nothing else — no tenant, no user, no invitation. Rate-limited on the AUTH tier (per
// client IP).
//
// ENUMERATION-SAFE: a duplicate KRA PIN, owner National ID or owner email is answered with
// the SAME 202 as a clean application (the reviewer sees the clash; approval refuses it).
// Only a missing or malformed field, or a business name / subdomain already taken — public
// facts — is answered 400.
// ===========================================================================

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { RATE_LIMITS } from "../plugins/security";
import { errorBody, errorResponses, PUBLIC } from "../schemas/common";
import { submitSelfServeApplication } from "../services/tenants/applications";
import { zOnboardingCandidate } from "./tenants";

export const SIGNUP_RECEIVED_MESSAGE =
  "Thank you — your application has been received. We will review it and contact the owner by email.";

export async function publicSignupRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.route({
    method: "POST",
    url: "/signup",
    config: { rateLimit: RATE_LIMITS.AUTH },
    schema: {
      tags: ["Tenants"],
      summary: "Apply to open a business on the platform (public)",
      description:
        "Public, rate-limited per IP. Creates an application for review — NO business is created until a SUPER_ADMIN approves it. The subdomain is proposed by the platform. A missing or malformed field, or a business name already registered ('pick another'), is a 400; every other outcome is the same 202 acknowledgement.",
      security: PUBLIC,
      body: zOnboardingCandidate.omit({ subdomain: true }),
      response: {
        202: z.object({ message: z.string(), applicationId: z.string() }),
        ...errorResponses(400, 429),
      },
    },
    handler: async (request, reply) => {
      const outcome = await submitSelfServeApplication(request.body, request.ip);
      if (outcome.kind === "REFUSED") {
        return reply
          .code(400)
          .send(errorBody(400, "BadRequest", outcome.errors.map((e) => `${e.field}: ${e.message}`).join("; ")));
      }
      return reply.code(202).send({ message: SIGNUP_RECEIVED_MESSAGE, applicationId: outcome.applicationId });
    },
  });
}
