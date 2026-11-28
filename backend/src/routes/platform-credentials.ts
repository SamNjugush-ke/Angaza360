// ===========================================================================
// /v1/platform-credentials — ANGAZA'S OWN NOTIFICATION CREDENTIALS (M4.5 Wave 5).
//
// SUPER_ADMIN only. The Command Center's "Platform notifications" panel: the SMTP, Africa's
// Talking and SendGrid credentials the PLATFORM sends invitations, reset codes and status
// messages with — never a business's M-Pesa or eTIMS keys (those are the owner's, at
// /v1/integrations, MSME_OWNER only; the provider enum here cannot name them).
//
//   GET  /                                     every provider x environment slot, SAFE views only
//   PUT  /{provider}/{environment}             store / rotate — write-only fields; PENDING after
//   POST /{provider}/{environment}/activate    PENDING | INACTIVE -> ACTIVE
//   POST /{provider}/{environment}/deactivate  PENDING | ACTIVE -> INACTIVE
//   POST /{provider}/{environment}/verify      test the stored credential (sends nothing; idempotent)
//
// Storing, activating and deactivating change how the platform reaches every user, so each needs a
// fresh MFA step-up; verifying does not. NO RESPONSE CARRIES A FIELD VALUE: the response schemas
// declare none and the Zod serialiser strips anything undeclared; `req.body.fields` is redacted
// from the request log. Every change and every verify is audited.
// ===========================================================================

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { RATE_LIMITS } from "../plugins/security";
import { badRequest, conflict, errorResponses, notFound, SECURE } from "../schemas/common";
import { platformCredentialEnvironment, PlatformCredentialNotFoundError, PlatformCredentialStateError } from "../services/credentials/credential-store";
import { CredentialValidationError, PLATFORM_NOTIFICATION_PROVIDERS } from "../services/credentials/provider-schemas";
import {
  listPlatformCredentialSlots,
  PLATFORM_CREDENTIAL_ENVIRONMENTS,
  PLATFORM_CREDENTIAL_FIELDS,
  setCredentialActive,
  storeCredential,
  verifyCredential,
} from "../services/notifications/platform-credentials";

const zProvider = z.enum(PLATFORM_NOTIFICATION_PROVIDERS);
const zEnvironment = z.enum(PLATFORM_CREDENTIAL_ENVIRONMENTS);
const zParams = z.object({ provider: zProvider, environment: zEnvironment });

const zSafeView = z
  .object({
    id: z.string(),
    provider: z.string().meta({ description: "SMTP | SENDGRID | AFRICASTALKING" }),
    environment: z.string().meta({ description: "sandbox | production" }),
    status: z.string().meta({ description: "PENDING | ACTIVE | INACTIVE" }),
    label: z.string().nullable(),
    keyRef: z.string(),
    healthStatus: z.string().meta({ description: "UNVERIFIED | HEALTHY | FAILING" }),
    lastHealthCheckAt: z.date().nullable(),
    lastHealthError: z.string().nullable(),
    lastVerifiedAt: z.date().nullable(),
    updatedById: z.string().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .meta({ description: "A platform credential's SAFE view: no ciphertext, no field value, not even a field name." });

const zField = z.object({ key: z.string(), label: z.string(), secret: z.boolean(), required: z.boolean() });

const zStoreBody = z.object({
  fields: z.record(z.string(), z.string().max(500)).meta({ description: "The provider's fields, all strings. **Write-only** — encrypted and never returned." }),
  label: z.string().trim().min(1).max(120).optional(),
});

const zVerifyResult = z.object({ ok: z.boolean(), detail: z.string(), credential: zSafeView });

export async function platformCredentialRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const superAdmin = [app.requireAuth, app.requireRole("SUPER_ADMIN")];
  const withStepUp = [...superAdmin, app.requireStepUp];
  const actorOf = (request: { auth: { userId: string } | null; ip: string }) => ({ userId: request.auth?.userId ?? "", ipAddress: request.ip });

  const stateErrors = (error: unknown) => {
    if (error instanceof PlatformCredentialNotFoundError) return { code: 404 as const, body: notFound(error.message) };
    if (error instanceof PlatformCredentialStateError) return { code: 409 as const, body: conflict(error.message) };
    if (error instanceof CredentialValidationError) return { code: 400 as const, body: badRequest(error.message) };
    return null;
  };

  api.route({
    method: "GET",
    url: "/",
    preHandler: superAdmin,
    schema: {
      tags: ["Platform credentials"],
      summary: "Angaza's notification credentials, by provider and environment (safe views)",
      security: SECURE,
      response: {
        200: z.object({
          data: z.array(z.object({ provider: zProvider, environment: zEnvironment, credential: zSafeView.nullable() })),
          fields: z.record(zProvider, z.array(zField)),
          activeEnvironment: zEnvironment.meta({ description: "The environment this deployment SENDS from (production in production, sandbox elsewhere)." }),
        }),
        ...errorResponses(401, 403),
      },
    },
    handler: async (_request, reply) => {
      return reply.code(200).send({
        data: await listPlatformCredentialSlots(),
        fields: { SMTP: [...PLATFORM_CREDENTIAL_FIELDS.SMTP], SENDGRID: [...PLATFORM_CREDENTIAL_FIELDS.SENDGRID], AFRICASTALKING: [...PLATFORM_CREDENTIAL_FIELDS.AFRICASTALKING] },
        activeEnvironment: platformCredentialEnvironment(),
      });
    },
  });

  api.route({
    method: "PUT",
    url: "/:provider/:environment",
    preHandler: withStepUp,
    config: { rateLimit: RATE_LIMITS.SENSITIVE },
    schema: {
      tags: ["Platform credentials"],
      summary: "Store or rotate a platform credential (SUPER_ADMIN, after an MFA step-up)",
      description: "Validated against the provider's shape, encrypted (AES-256-GCM) and stored PENDING and UNVERIFIED — activate it separately. **The response is a safe view; nothing sent here is ever echoed back.**",
      security: SECURE,
      params: zParams,
      body: zStoreBody,
      response: { 200: zSafeView, ...errorResponses(400, 401, 403, 404, 409, 429) },
    },
    handler: async (request, reply) => {
      try {
        const { provider, environment } = request.params;
        return reply.code(200).send(await storeCredential(actorOf(request), provider, environment, request.body.fields, request.body.label ?? null));
      } catch (error) {
        const mapped = stateErrors(error);
        if (mapped !== null) return reply.code(mapped.code).send(mapped.body);
        throw error;
      }
    },
  });

  for (const [action, active] of [["activate", true], ["deactivate", false]] as const) {
    api.route({
      method: "POST",
      url: `/:provider/:environment/${action}`,
      preHandler: withStepUp,
      config: { rateLimit: RATE_LIMITS.SENSITIVE },
      schema: {
        tags: ["Platform credentials"],
        summary: active ? "Put a stored platform credential into service" : "Take a platform credential out of service",
        security: SECURE,
        params: zParams,
        response: { 200: zSafeView, ...errorResponses(400, 401, 403, 404, 409, 429) },
      },
      handler: async (request, reply) => {
        try {
          return reply.code(200).send(await setCredentialActive(actorOf(request), request.params.provider, request.params.environment, active));
        } catch (error) {
          const mapped = stateErrors(error);
          if (mapped !== null) return reply.code(mapped.code).send(mapped.body);
          throw error;
        }
      },
    });
  }

  api.route({
    method: "POST",
    url: "/:provider/:environment/verify",
    preHandler: superAdmin,
    config: { rateLimit: RATE_LIMITS.SENSITIVE },
    schema: {
      tags: ["Platform credentials"],
      summary: "Test a stored platform credential (sends nothing)",
      description: "SMTP connects and signs in; SendGrid reads the key's scopes; Africa's Talking reads the account. Records the outcome on the credential (and audits it). Idempotent. The detail never contains a field value.",
      security: SECURE,
      params: zParams,
      response: { 200: zVerifyResult, ...errorResponses(400, 401, 403, 404, 409, 429) },
    },
    handler: async (request, reply) => {
      try {
        return reply.code(200).send(await verifyCredential(actorOf(request), request.params.provider, request.params.environment));
      } catch (error) {
        const mapped = stateErrors(error);
        if (mapped !== null) return reply.code(mapped.code).send(mapped.body);
        throw error;
      }
    },
  });
}
