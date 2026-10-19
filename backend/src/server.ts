import { createRequire } from "node:module";
import Fastify, { type FastifyError, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import {
  createSerializerCompiler,
  validatorCompiler,
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { env } from "./config/env";
import { platformDb } from "./db/platform";
import { disconnectAllTenantDbs } from "./db/tenant";
import { closePool } from "./db/pool";
import { registerAuth } from "./plugins/auth";
import { registerDocs } from "./plugins/docs";
import { registerSecurity } from "./plugins/security";
import { errorBody, zError } from "./schemas/common";
import { authRoutes } from "./routes/auth";
import { productRoutes } from "./routes/products";
import { accountRoutes } from "./routes/accounts";
import { ledgerRoutes } from "./routes/ledger";
import { inventoryRoutes } from "./routes/inventory";
import { locationRoutes } from "./routes/locations";
import { allocationRoutes } from "./routes/allocations";
import { posRoutes } from "./routes/pos";
import { offlineRoutes } from "./routes/offline";
import { etimsRoutes } from "./routes/etims";
import { procurementRoutes } from "./routes/procurement";
import { payablesRoutes } from "./routes/payables";
import { receivablesRoutes } from "./routes/receivables";
import { payrollRoutes } from "./routes/payroll";
import { reportRoutes } from "./routes/reports";
import { mentorshipRoutes } from "./routes/mentorship";
import { settingsRoutes } from "./routes/settings";
import { customerRoutes } from "./routes/customers";
import { mpesaRoutes, mpesaWebhookRoutes, mpesaDevRoutes } from "./routes/mpesa";
import { integrationRoutes } from "./routes/integrations";
import { userRoutes } from "./routes/users";
import { tenantRoutes } from "./routes/tenants";
import { expenseRoutes } from "./routes/expenses";
import { dashboardRoutes } from "./routes/dashboard";
import { donorProjectRoutes } from "./routes/donor-projects";
import { tenantApplicationRoutes } from "./routes/tenant-applications";
import { publicSignupRoutes } from "./routes/public-signup";

// The documented API version is the package version — one source of truth, read
// at runtime so package.json stays outside the TypeScript rootDir.
const { version: apiVersion } = createRequire(__filename)("../package.json") as {
  version: string;
};

// BigInt money is not JSON-serialisable and would throw in the serialiser. Fix
// it once, at the boundary, for every route: a bigint at any depth is rendered
// as a decimal STRING, never as a JS number (2^53 and float coercion are both
// real hazards for an accounting API).
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

// Path segments that ARE secrets, replaced before a URL reaches a log line. A request
// log that printed them would put a live invitation token or the webhook's gate secret
// into every log aggregator that ever receives it.
const SECRET_PATH_SEGMENTS: readonly RegExp[] = [
  /^(\/v1\/users\/invitations\/)[^/?#]+(\/accept)/,
  /^(\/v1\/webhooks\/mpesa\/)[^/?#]+(\/)/,
];

export function maskSecretPathSegments(url: string): string {
  return SECRET_PATH_SEGMENTS.reduce((masked, pattern) => masked.replace(pattern, "$1[redacted]$2"), url);
}

const zHealth = z.object({ status: z.literal("ok") });

const zHealthDb = z.object({
  status: z.literal("ok"),
  database: z.string(),
  tenants: z.number().int(),
});

// Exported so the test suite can inject against the WHOLE app (app.inject, no socket).
// Building the app opens no port; only start() listens.
export async function buildServer() {
  const app = Fastify({
    logger: {
      // Never let secrets reach the logs, even if a request/response body or
      // headers are ever serialised.
      redact: [
        "req.headers.authorization",
        "req.body.password",
        "req.body.refreshToken",
        "res.body.accessToken",
        "res.body.refreshToken",
        // Integration credential fields (Task 3.4) arrive as req.body.fields on
        // PUT /v1/integrations/:provider/credentials. They are the only
        // plaintext secrets that ever cross an authenticated request boundary,
        // so redact the whole object rather than naming each provider's fields.
        "req.body.fields",
        // Password recovery / lifecycle (Task T-A4): the reset code and both passwords.
        "req.body.token",
        "req.body.newPassword",
        "req.body.currentPassword",
      ],
      // Secrets that travel in a URL PATH are masked in every request log line (Task
      // T-A5): the single-use invitation token in the accept URL, and the M-Pesa
      // webhook's unguessable path secret.
      serializers: {
        req(request: FastifyRequest) {
          return {
            method: request.method,
            url: maskSecretPathSegments(request.url),
            host: request.host,
            remoteAddress: request.ip,
            remotePort: request.socket.remotePort,
          };
        },
      },
    },
  });

  // ---- Zod as the single schema authority (Task G.3) -----------------------
  // validatorCompiler makes each route's Zod schema its request validator;
  // createSerializerCompiler makes it the response serialiser. The serialiser
  // is built WITH the bigint replacer so schema-validated responses still emit
  // money as a string: the zod codecs in schemas/common.ts encode bigint ->
  // string, and this replacer is the belt-and-braces backstop for any bigint
  // that reaches JSON.stringify by another route (e.g. inside a passthrough).
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(createSerializerCompiler({ replacer: bigintReplacer }));

  // Fastify uses a reply serialiser ONLY where a route declares no response
  // schema (health checks, the swagger-ui assets). Keeping it means bigint is
  // stringified on both paths — there is no route through which a bigint can
  // reach a client as a JSON number.
  app.setReplySerializer((payload) => JSON.stringify(payload, bigintReplacer));

  // ---- One error shape for the whole API ----------------------------------
  // Schema validation failures and unhandled errors are rendered as the same
  // documented `Error` object every route already declares, so the OpenAPI
  // document tells the truth for failures as well as successes.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      const detail = error.validation
        .map((issue) => {
          const path = issue.instancePath === "" ? "" : `${issue.instancePath}: `;
          return `${path}${issue.message}`;
        })
        .join("; ");
      return reply
        .code(400)
        .send(
          errorBody(400, "BadRequest", detail === "" ? "Request does not match the schema." : detail),
        );
    }

    if (isResponseSerializationError(error)) {
      // The handler produced something its own response schema forbids. That is
      // our bug, never the caller's — 500, logged loudly, and the caller is not
      // shown the internals.
      request.log.error(
        { url: error.url, method: error.method, issues: error.cause.issues },
        "response does not match its schema",
      );
      return reply
        .code(500)
        .send(errorBody(500, "InternalServerError", "Response does not match its schema."));
    }

    const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
    if (statusCode >= 500) {
      request.log.error(error);
      return reply
        .code(statusCode)
        .send(errorBody(statusCode, "InternalServerError", "An unexpected error occurred."));
    }
    // 4xx raised by a plugin (rate limit, malformed JSON, unsupported media
    // type). Preserve the status and message; normalise the shape.
    return reply
      .code(statusCode)
      .send(errorBody(statusCode, statusCode === 429 ? "TooManyRequests" : "BadRequest", error.message));
  });

  // CSV uploads (Task T-A6.3) arrive as a text/csv request body — no multipart
  // dependency. The parser hands the route the raw text; the CSV framework
  // (src/services/csv) validates it. 1 MiB is ample for the row caps it enforces.
  app.addContentTypeParser("text/csv", { parseAs: "string", bodyLimit: 1_048_576 }, (_request, body, done) => {
    done(null, body);
  });

  // Security headers + the single rate-limit registration (Task T-A2). Registered
  // directly on the root instance, before cors and before ANY route, so its hooks
  // wrap every route — /docs and the webhook included.
  await registerSecurity(app);

  await app.register(cors, {
    origin: env.corsOrigin.split(","),
  });

  // Registered directly on the root instance (not via app.register) so the auth
  // decorators are visible app-wide — the encapsulate:false pattern.
  await registerAuth(app);

  // Docs must come after registerAuth (it uses requireAuth to gate /docs in
  // production) and before the routes, so every route is captured in the spec.
  await registerDocs(app, apiVersion);

  const api = app.withTypeProvider<ZodTypeProvider>();

  api.route({
    method: "GET",
    url: "/health",
    schema: {
      tags: ["Health"],
      summary: "Liveness probe",
      description: "Returns ok if the process is up. Public — no authentication.",
      security: [],
      response: { 200: zHealth },
    },
    handler: async () => ({ status: "ok" as const }),
  });

  api.route({
    method: "GET",
    url: "/health/db",
    schema: {
      tags: ["Health"],
      summary: "Database connectivity probe",
      description:
        "Verifies the platform database answers and reports the tenant count. Public — no authentication.",
      security: [],
      response: { 200: zHealthDb, 503: zError },
    },
    handler: async (_request, reply) => {
      try {
        await platformDb.$queryRaw`SELECT 1`;
        const tenants = await platformDb.tenant.count();
        return { status: "ok" as const, database: "angaza_core", tenants };
      } catch (error) {
        app.log.error(error);
        const message = error instanceof Error ? error.message : "Unknown database error";
        return reply.code(503).send(errorBody(503, "ServiceUnavailable", message));
      }
    },
  });

  await app.register(authRoutes, { prefix: "/v1/auth" });
  await app.register(productRoutes, { prefix: "/v1/products" });
  await app.register(accountRoutes, { prefix: "/v1/accounts" });
  await app.register(ledgerRoutes, { prefix: "/v1/ledger" });
  await app.register(inventoryRoutes, { prefix: "/v1/inventory" });
  await app.register(locationRoutes, { prefix: "/v1/locations" });
  await app.register(allocationRoutes, { prefix: "/v1/allocations" });
  await app.register(posRoutes, { prefix: "/v1/pos" });
  await app.register(offlineRoutes, { prefix: "/v1/offline" });
  await app.register(etimsRoutes, { prefix: "/v1/etims" });
  await app.register(procurementRoutes, { prefix: "/v1/procurement" });
  await app.register(payablesRoutes, { prefix: "/v1/payables" });
  await app.register(receivablesRoutes, { prefix: "/v1/receivables" });
  await app.register(payrollRoutes, { prefix: "/v1/payroll" });
  await app.register(reportRoutes, { prefix: "/v1/reports" });
  await app.register(mentorshipRoutes, { prefix: "/v1/mentorship" });
  await app.register(settingsRoutes, { prefix: "/v1/settings" });
  await app.register(mpesaRoutes, { prefix: "/v1/pos" });
  await app.register(customerRoutes, { prefix: "/v1/customers" });
  await app.register(integrationRoutes, { prefix: "/v1/integrations" });
  await app.register(userRoutes, { prefix: "/v1/users" });
  await app.register(tenantRoutes, { prefix: "/v1/tenants" });
  await app.register(expenseRoutes, { prefix: "/v1/expenses" });
  await app.register(dashboardRoutes, { prefix: "/v1/dashboard" });
  await app.register(donorProjectRoutes, { prefix: "/v1/donor-projects" });
  await app.register(tenantApplicationRoutes, { prefix: "/v1/tenant-applications" });
  // Public self-serve signup (Task T-A6.2): creates an application, never a tenant.
  await app.register(publicSignupRoutes, { prefix: "/v1/public" });

  // Public M-Pesa callback webhook (no auth; tenant from the server-generated
  // path, gated by the unguessable path secret).
  await app.register(mpesaWebhookRoutes, { prefix: "/v1/webhooks" });

  // Simulator control routes are mounted ONLY when the provider is the
  // simulator; under daraja mpesaDevRoutes registers nothing (route 404s).
  await app.register(mpesaDevRoutes, { prefix: "/v1/dev" });

  app.addHook("onClose", async () => {
    await platformDb.$disconnect();
    await disconnectAllTenantDbs();
    await closePool();
  });

  return app;
}

async function start() {
  const app = await buildServer();

  try {
    await app.listen({ port: env.port, host: env.host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (): Promise<void> => {
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

// Listen only when this module is the entrypoint (`node dist/server.js`, `tsx
// src/server.ts`) — importing it, as the test suite does, must not open a port.
if (require.main === module) {
  start();
}
