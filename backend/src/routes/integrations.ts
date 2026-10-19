// ===========================================================================
// Tenant integration settings (Task 3.4), mounted at /v1/integrations.
//
// MSME_OWNER ONLY. Integration credentials are the keys to the shop's money —
// a manager or cashier has no business reading, replacing, or activating them,
// and "Go Live" is an owner's decision.
//
// SECRETS ARE WRITE-ONLY THROUGH THIS API. Credential fields are accepted on a
// PUT and are never returned by anything. Since Task G.3 that is enforced
// structurally as well as by discipline: every response here is declared as a
// Zod schema built from zCredentialSafeView, and the Zod serialiser strips any
// property the schema does not declare. A secret cannot leave through this
// router even if a future edit tried to send one — and the OpenAPI document
// generated from those same schemas proves it to a reader.
//
// GOING LIVE IS A CONFIG ACTION: store the production credentials, activate
// them, then PUT settings with activeEnvironment=PRODUCTION. The store refuses
// the flip if no ACTIVE production credential exists, so a tenant cannot point
// live traffic at credentials that are not there.
// ===========================================================================

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  activateCredential,
  getCredentialSafe,
  getIntegrationSetting,
  IntegrationSettingError,
  listCredentialsSafe,
  NoActiveCredentialError,
  putCredential,
  setIntegrationSetting,
  type CredentialSafeView,
} from "../services/credentials/credential-store";
import {
  CredentialValidationError,
  hasRegisteredCredentialShape,
  INTEGRATION_PROVIDERS,
  type IntegrationProviderName,
} from "../services/credentials/provider-schemas";
import { CredentialDecryptError } from "../lib/crypto/credential-cipher";
import {
  zCredentialSafeView,
  zIntegrationEnvironment,
  zIntegrationProvider,
  zIntegrationSettingView,
} from "../schemas/models";
import { badRequest, errorBody, errorResponses, notFound, SECURE } from "../schemas/common";
import { RATE_LIMITS } from "../plugins/security";

const zProviderParam = z.object({
  provider: zIntegrationProvider.meta({
    description: "Integration provider. Only MPESA accepts credentials today.",
  }),
});

const zProviderEnvironmentParams = zProviderParam.extend({
  environment: zIntegrationEnvironment,
});

// The ONLY place a secret appears in any schema in this file — and it is a
// REQUEST schema. There is deliberately no response schema anywhere that
// contains a credential field.
const zCredentialFields = z
  .record(z.string(), z.string())
  .meta({
    description:
      "Provider-specific credential fields, all strings. For MPESA: consumerKey, consumerSecret, shortcode, passkey, and optionally initiatorName / initiatorPassword. **Write-only** — these values are encrypted with AES-256-GCM before storage and are never returned by any endpoint.",
    examples: [
      {
        consumerKey: "your-daraja-consumer-key",
        consumerSecret: "your-daraja-consumer-secret",
        shortcode: "174379",
        passkey: "your-daraja-passkey",
      },
    ],
  });

const zPutCredentialBody = z.object({
  environment: zIntegrationEnvironment,
  fields: zCredentialFields,
  label: z.string().trim().min(1).optional().meta({
    description: 'Human note, e.g. "Till 174379". Not a secret.',
  }),
});

const zSettingsBody = z
  .object({
    activeEnvironment: zIntegrationEnvironment.optional().meta({
      description:
        'The "Go Live" control. Flipping SANDBOX -> PRODUCTION is refused unless an ACTIVE production credential exists.',
    }),
    enabled: z.boolean().optional(),
  })
  .refine(
    (body) => body.activeEnvironment !== undefined || body.enabled !== undefined,
    { message: "Provide activeEnvironment and/or enabled." },
  );

const zProviderSummary = z.object({
  provider: zIntegrationProvider,
  credentialsSupported: z.boolean().meta({
    description:
      "Whether credentials for this provider can be stored yet. ETIMS/STRIPE/SMS are declared slots whose blob shape lands with the task that builds them.",
  }),
  settings: zIntegrationSettingView,
  credentials: z.array(zCredentialSafeView),
});

export async function integrationRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const ownerOnly = [app.requireAuth, app.requireTenant, app.requireRole("MSME_OWNER")];

  api.route({
    method: "GET",
    url: "/",
    preHandler: ownerOnly,
    schema: {
      tags: ["Integrations"],
      summary: "List every provider's settings and stored credentials",
      description:
        "Everything the settings screen needs. Credentials are SAFE VIEWS only — no ciphertext and no secret field is ever returned.",
      security: SECURE,
      response: {
        200: z.object({ data: z.array(zProviderSummary) }),
        ...errorResponses(401, 403),
      },
    },
    handler: async (request, reply) => {
      const db = request.tenantDb;
      const stored = await listCredentialsSafe(db);

      const summaries: Array<{
        provider: IntegrationProviderName;
        credentialsSupported: boolean;
        settings: Awaited<ReturnType<typeof getIntegrationSetting>>;
        credentials: CredentialSafeView[];
      }> = [];
      for (const provider of INTEGRATION_PROVIDERS) {
        const settings = await getIntegrationSetting(db, provider);
        summaries.push({
          provider,
          credentialsSupported: hasRegisteredCredentialShape(provider),
          settings,
          credentials: stored.filter((row) => row.provider === provider),
        });
      }

      return reply.code(200).send({ data: summaries });
    },
  });

  api.route({
    method: "GET",
    url: "/:provider/credentials/:environment",
    preHandler: ownerOnly,
    schema: {
      tags: ["Integrations"],
      summary: "Get one stored credential's safe view",
      description: "Never returns the blob or any decrypted field.",
      security: SECURE,
      params: zProviderEnvironmentParams,
      response: { 200: zCredentialSafeView, ...errorResponses(400, 401, 403, 404) },
    },
    handler: async (request, reply) => {
      const { provider, environment } = request.params;
      const view = await getCredentialSafe(request.tenantDb, provider, environment);
      if (view === null) {
        return reply
          .code(404)
          .send(notFound(`No ${provider} credential stored for the ${environment} environment.`));
      }
      return reply.code(200).send(view);
    },
  });

  api.route({
    method: "PUT",
    url: "/:provider/credentials",
    // A secret write: throttled per client IP (Task T-A2).
    config: { rateLimit: RATE_LIMITS.SENSITIVE },
    preHandler: ownerOnly,
    schema: {
      tags: ["Integrations"],
      summary: "Store or rotate a provider's credentials",
      description:
        "Rate-limited (SENSITIVE tier). Fields are validated against the provider's registered shape, encrypted with AES-256-GCM, and stored PENDING — storing a credential is not the same as putting it into service, so activate it separately. Rotating clears the previous verification. **The response is a safe view; the secrets sent here are never echoed back.**",
      security: SECURE,
      params: zProviderParam,
      body: zPutCredentialBody,
      response: { 200: zCredentialSafeView, ...errorResponses(400, 401, 403, 429) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      const { provider } = request.params;
      const body = request.body;

      try {
        const view = await putCredential(request.tenantDb, {
          provider,
          environment: body.environment,
          fields: body.fields,
          label: body.label ?? null,
          createdBy: auth.userId,
        });
        // Only the SAFE view goes back. The secrets that arrived in this request
        // do not appear in this response.
        return reply.code(200).send(view);
      } catch (error) {
        if (error instanceof CredentialValidationError) {
          return reply.code(400).send(badRequest(error.message));
        }
        throw error;
      }
    },
  });

  api.route({
    method: "POST",
    url: "/:provider/credentials/:environment/activate",
    preHandler: ownerOnly,
    schema: {
      tags: ["Integrations"],
      summary: "Put a stored credential into service",
      description:
        "Decrypts and re-validates before marking the row ACTIVE — a credential that cannot be decrypted must fail here, not at the till. At most one ACTIVE credential per provider+environment (enforced by a partial unique index).",
      security: SECURE,
      params: zProviderEnvironmentParams,
      response: { 200: zCredentialSafeView, ...errorResponses(400, 401, 403, 404) },
    },
    handler: async (request, reply) => {
      const { provider, environment } = request.params;
      try {
        const view = await activateCredential(request.tenantDb, provider, environment);
        return reply.code(200).send(view);
      } catch (error) {
        if (error instanceof NoActiveCredentialError) {
          return reply
            .code(404)
            .send(
              notFound(
                `No ${provider} credential is stored for the ${environment} environment; store it before activating.`,
              ),
            );
        }
        if (
          error instanceof CredentialValidationError ||
          error instanceof CredentialDecryptError
        ) {
          return reply.code(400).send(badRequest(error.message));
        }
        throw error;
      }
    },
  });

  api.route({
    method: "PUT",
    url: "/:provider/settings",
    preHandler: ownerOnly,
    schema: {
      tags: ["Integrations"],
      summary: 'Set the active environment and on/off state (the "Go Live" control)',
      description:
        "Pointing activeEnvironment at an environment with no ACTIVE credential is refused with 400. Going live is therefore: store production credentials, activate them, flip this — a config action, never a deploy.",
      security: SECURE,
      params: zProviderParam,
      body: zSettingsBody,
      response: { 200: zIntegrationSettingView, ...errorResponses(400, 401, 403) },
    },
    handler: async (request, reply) => {
      const { provider } = request.params;
      const body = request.body;
      try {
        const view = await setIntegrationSetting(request.tenantDb, provider, {
          ...(body.activeEnvironment !== undefined
            ? { activeEnvironment: body.activeEnvironment }
            : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        });
        return reply.code(200).send(view);
      } catch (error) {
        if (error instanceof IntegrationSettingError) {
          return reply.code(400).send(badRequest(error.message));
        }
        throw error;
      }
    },
  });
}
