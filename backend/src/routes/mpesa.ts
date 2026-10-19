import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { env } from "../config/env";
import { RATE_LIMITS } from "../plugins/security";
import {
  initiateStkPushForTender,
  handleCallback,
  getMpesaTransactionStatus,
  MpesaPaymentError,
} from "../services/mpesa/payment";
import {
  buildSimulatedCallbackEnvelope,
  type SimulatedOutcome,
} from "../services/mpesa/simulated-provider";
import { IntegrationDisabledError } from "../services/mpesa/factory";
import { NoActiveCredentialError } from "../services/credentials/credential-store";
import { zMpesaTxnStatus } from "../schemas/models";
import {
  badRequest,
  errorBody,
  errorResponses,
  notFound,
  PUBLIC,
  SECURE,
  zCentsString,
} from "../schemas/common";

const zStkPushBody = z.object({
  phoneNumber: z
    .string()
    .trim()
    .min(1, "phoneNumber is required.")
    .meta({ examples: ["254712345678"], description: "MSISDN in 2547XXXXXXXX form." }),
});

const zStkPushResult = z.object({
  checkoutRequestId: z.string().meta({
    description: "Daraja's correlation id. The callback is matched against it.",
  }),
  mpesaTransactionId: z.string(),
  status: zMpesaTxnStatus,
});

// The webhook's reply bodies are built by the callback service, not by a
// schema. See the response block on the webhook route for why.
const zWebhookBody = z.record(z.string(), z.unknown());

const zMpesaTransactionStatus = z.object({
  checkoutRequestId: z.string(),
  status: zMpesaTxnStatus,
  amount: zCentsString,
  resultCode: z.number().int().nullable(),
  resultDesc: z.string().nullable(),
  mpesaReceiptNumber: z.string().nullable(),
  saleId: z.string().nullable(),
  tenderId: z.string().nullable(),
});

// ---- Authenticated STK push + poll (registered under /v1/pos) ----
export async function mpesaRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const base = [app.requireAuth, app.requireTenant];
  const tillRoles = app.requireRole("CASHIER", "MSME_MANAGER", "MSME_OWNER");

  api.route({
    method: "POST",
    url: "/sales/:saleId/tenders/:tenderId/stk-push",
    preHandler: [...base, tillRoles],
    schema: {
      tags: ["M-Pesa"],
      summary: "Send an STK Push for a pending M-Pesa tender",
      description:
        "Constructs the provider from THIS tenant's own active M-Pesa credentials (Task 3.4) and pushes to the customer's phone. Returns the checkoutRequestId to poll. A tenant with no active credentials gets 400, never a fallback to a shared shortcode.",
      security: SECURE,
      params: z.object({
        saleId: z.string().min(1),
        tenderId: z.string().min(1),
      }),
      body: zStkPushBody,
      response: {
        201: zStkPushResult,
        ...errorResponses(400, 401, 403),
      },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null || auth.tenant === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      const { saleId, tenderId } = request.params;
      try {
        const result = await initiateStkPushForTender(request.tenantDb, {
          saleId,
          tenderId,
          phoneNumber: request.body.phoneNumber,
          createdBy: auth.userId,
          tenant: auth.tenant,
        });
        return reply.code(201).send(result);
      } catch (error) {
        if (error instanceof MpesaPaymentError) {
          return reply.code(400).send(badRequest(error.message));
        }
        // The tenant has not onboarded M-Pesa (or switched it off). That is a
        // configuration state, not a server fault — 400 with the store's own
        // message, which tells the owner exactly what to do.
        if (
          error instanceof NoActiveCredentialError ||
          error instanceof IntegrationDisabledError
        ) {
          return reply
            .code(400)
            .send(errorBody(400, "IntegrationNotConfigured", error.message));
        }
        throw error;
      }
    },
  });

  api.route({
    method: "GET",
    url: "/mpesa/:checkoutRequestId",
    preHandler: [
      ...base,
      app.requireRole("CASHIER", "MSME_MANAGER", "MSME_OWNER", "ACCOUNTANT", "VIEWER_AUDITOR"),
    ],
    schema: {
      tags: ["M-Pesa"],
      summary: "Poll an STK transaction's status",
      description:
        "INITIATED until a callback (or the nightly timeout sweep) moves it to a terminal state. Terminal states are final.",
      security: SECURE,
      params: z.object({ checkoutRequestId: z.string().min(1) }),
      response: {
        200: zMpesaTransactionStatus,
        ...errorResponses(401, 403, 404),
      },
    },
    handler: async (request, reply) => {
      const status = await getMpesaTransactionStatus(
        request.tenantDb,
        request.params.checkoutRequestId,
      );
      if (status === null) {
        return reply.code(404).send(notFound("No M-Pesa transaction with that id."));
      }
      return reply.code(200).send(status);
    },
  });
}

// ---- Public webhook (registered under /v1/webhooks, NO auth) ----
// The ONLY unauthenticated write path in the system. Tenant identity comes from
// the server-generated path (:tenantSlug), never the body; gated by the
// unguessable :pathSecret; rate-limited.
export async function mpesaWebhookRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.route({
    method: "POST",
    url: "/mpesa/:pathSecret/:tenantSlug",
    // The WEBHOOK tier (src/plugins/security.ts registers the limiter once,
    // app-wide). It runs at onRequest, exactly as the plugin-local registration
    // did, so its position relative to the path-secret gate below is unchanged.
    config: {
      rateLimit: RATE_LIMITS.WEBHOOK,
    },
    // ORDERING MATTERS (Task G.3). Fastify validates the body BEFORE the
    // handler, so documenting a body schema would let a malformed payload
    // return 400 on a URL whose path secret is wrong — revealing that this
    // endpoint exists. This hook runs BEFORE validation and reproduces the
    // 3.3 gate: a wrong secret is a 404 and nothing else is disclosed. The
    // same check remains inside handleCallback; this one only preserves the
    // ordering that the schema would otherwise have changed.
    preValidation: async (request, reply) => {
      const { pathSecret } = request.params as { pathSecret: string };
      if (pathSecret !== env.mpesa.callbackPathSecret) {
        return reply.code(404).send({ error: "Not found" });
      }
      return undefined;
    },
    schema: {
      tags: ["M-Pesa"],
      summary: "Safaricom Daraja STK callback (public)",
      description:
        "**Called by Safaricom, not by clients. The only unauthenticated write path in the system.**\n\n" +
        "The URL is server-generated: `:pathSecret` is an unguessable secret and `:tenantSlug` is the registered tenant subdomain. Tenant identity is resolved from the PATH — never from the body, which is untrusted input. A wrong secret returns 404 (not 401) so the endpoint is not revealed.\n\n" +
        "Idempotent: a replayed or duplicate callback for a checkoutRequestId already in a terminal state is a 200 no-op with no second ledger entry. Returns 200 for any well-formed processed callback (providers retry on non-200) and 400 only for a malformed payload.",
      security: PUBLIC,
      params: z.object({
        pathSecret: z.string(),
        tenantSlug: z.string(),
      }),
      // Daraja's stkCallback envelope. The schema requires EXACTLY what
      // parseDarajaEnvelope requires (a CheckoutRequestID string and a numeric
      // ResultCode) and is loose about everything else, so it can never be
      // stricter than the parser. That matters for real money: a schema that
      // rejected a callback our parser would have accepted would silently drop
      // a payment confirmation Safaricom will not retry forever.
      body: z
        .looseObject({
          Body: z.looseObject({
            stkCallback: z.looseObject({
              MerchantRequestID: z.string().optional(),
              CheckoutRequestID: z.string(),
              ResultCode: z.number(),
              ResultDesc: z.string().optional(),
              CallbackMetadata: z
                .looseObject({
                  Item: z.array(
                    z.looseObject({
                      Name: z.string().optional(),
                      Value: z.unknown().optional(),
                    }),
                  ),
                })
                .optional(),
            }),
          }),
        })
        .meta({ id: "MpesaStkCallback" }),
      // The callback service owns these bodies. They are documented by shape
      // description and example rather than by a field-by-field schema, because
      // Safaricom is the only caller and it reads the STATUS CODE, not the body
      // — and because narrowing them here would put the schema, rather than the
      // reconciliation service, in charge of what a callback result may say.
      response: {
        200: zWebhookBody.meta({
          description:
            'Processed, including idempotent no-ops. `status` is one of "confirmed", "failed", "already_processed" or "ignored". A replayed callback returns "already_processed" and has no ledger effect.',
          examples: [{ status: "confirmed", receipt: "QK12ABC3XYZ" }],
        }),
        400: zWebhookBody.meta({
          description: "Malformed or inauthentic payload; no side effect.",
          examples: [{ error: "BadCallback", message: "Callback missing CheckoutRequestID." }],
        }),
        404: zWebhookBody.meta({
          description:
            "Wrong path secret or unknown tenant. Deliberately 404 and not 401, so the endpoint is not revealed.",
          examples: [{ error: "Not found" }],
        }),
        ...errorResponses(429),
      },
    },
    handler: async (request, reply) => {
      const { pathSecret, tenantSlug } = request.params;
      const result = await handleCallback({
        rawBody: request.body,
        headers: request.headers as Record<string, string | undefined>,
        pathSecret,
        tenantSlug,
      });
      const status = result.httpStatus;
      if (status !== 200 && status !== 400 && status !== 404) {
        // handleCallback only ever returns these three. If that changes, fail
        // loudly here rather than silently returning an undocumented status.
        throw new Error(
          `M-Pesa callback handler returned undocumented status ${status.toString()}.`,
        );
      }
      return reply.code(status).send(result.body);
    },
  });
}

// ---- Dev-only simulator control (registered under /v1/dev ONLY when the
// provider is the simulator). It fires a byte-compatible Daraja callback into
// the REAL webhook via in-process injection, so tests drive outcomes
// deterministically without network. It refuses to exist under daraja. ----
export async function mpesaDevRoutes(app: FastifyInstance): Promise<void> {
  // Hard guard: if this ever gets registered under daraja by mistake, do not
  // mount the route.
  if (env.mpesa.provider !== "simulated") {
    return;
  }

  const api = app.withTypeProvider<ZodTypeProvider>();
  const base = [app.requireAuth, app.requireTenant];

  api.route({
    method: "POST",
    url: "/mpesa/deliver",
    preHandler: [...base, app.requireRole("CASHIER", "MSME_MANAGER", "MSME_OWNER")],
    schema: {
      tags: ["M-Pesa"],
      summary: "Deliver a simulated M-Pesa callback (development only)",
      description:
        "Registered ONLY when MPESA_PROVIDER=simulated; it does not exist under the real provider. Builds a byte-compatible Daraja envelope and fires it into the real webhook in-process, so tests drive success/failure deterministically without network.",
      security: SECURE,
      body: z.object({
        checkoutRequestId: z.string().min(1, "checkoutRequestId is required."),
        outcome: z.enum(["success", "failure", "amount_mismatch"], {
          error: "outcome must be one of: success, failure, amount_mismatch.",
        }),
      }),
      response: {
        200: z.object({
          delivered: z.boolean(),
          webhookStatus: z.number().int(),
          webhookBody: z.unknown(),
        }),
        ...errorResponses(400, 401, 403, 404),
      },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null || auth.tenant === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      const body = request.body;

      const txn = await request.tenantDb.mpesaTransaction.findUnique({
        where: { checkoutRequestId: body.checkoutRequestId },
      });
      if (txn === null) {
        return reply.code(404).send(notFound("No such M-Pesa transaction in this tenant."));
      }

      const envelope = buildSimulatedCallbackEnvelope(
        {
          merchantRequestId: txn.merchantRequestId,
          checkoutRequestId: txn.checkoutRequestId,
          amountCents: txn.amount,
          phoneNumber: txn.phoneNumber,
        },
        body.outcome satisfies SimulatedOutcome,
      );

      // Fire it into the REAL webhook path, through the full app, in-process.
      const injected = await request.server.inject({
        method: "POST",
        url: `/v1/webhooks/mpesa/${env.mpesa.callbackPathSecret}/${auth.tenant.subdomain}`,
        payload: envelope as unknown as Record<string, unknown>,
      });

      let webhookBody: unknown = injected.body;
      try {
        webhookBody = JSON.parse(injected.body);
      } catch {
        // Not JSON (should not happen through our own webhook); pass the raw
        // string through so a test can still see what came back.
        webhookBody = injected.body;
      }
      return reply.code(200).send({
        delivered: true,
        webhookStatus: injected.statusCode,
        webhookBody,
      });
    },
  });

}
