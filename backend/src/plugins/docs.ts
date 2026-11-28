// ===========================================================================
// OpenAPI document + Swagger UI (Task G.3).
//
// The spec is GENERATED from the Zod schemas the routes actually validate
// with — there is no hand-written API document to fall out of date, and no
// JSDoc scraper. If a route's contract changes, /docs changes in the same
// commit because they are the same object.
//
// ACCESS CONTROL. An interactive explorer for a financial API is not a public
// asset: it enumerates every route and field and hands an attacker a working
// request builder. So:
//   * outside production            -> served openly (that is the point of dev)
//   * in production, docs disabled  -> the routes do not exist at all (404)
//   * in production, docs enabled   -> every docs route requires an
//                                      authenticated session (401 otherwise)
// Enabling docs in production takes an explicit API_DOCS_ENABLED=true; it is
// never the default.
// ===========================================================================

import type { FastifyInstance } from "fastify";
import { PRODUCT_NAME } from "../config/brand";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { jsonSchemaTransform, jsonSchemaTransformObject } from "fastify-type-provider-zod";
import { env } from "../config/env";
import { API_TAGS, BEARER_SCHEME } from "../schemas/common";

const DOCS_ROUTE_PREFIX = "/docs";

// CONTENT SECURITY POLICY FOR THE SWAGGER-UI SUBTREE ONLY (Task T-A2). The app-wide
// policy (src/plugins/security.ts) is default-src 'none', which is right for a JSON
// API and would leave swagger-ui a blank page. swagger-ui applies this string in an
// onSend hook scoped to ITS OWN routes (everything under /docs), replacing the
// global header there and nowhere else. 'self' covers its bundled scripts and
// styles and its fetch of /docs/json; 'unsafe-inline' and data: images are what its
// assets need. Framing and <base> stay forbidden, exactly as app-wide.
const DOCS_CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

export async function registerDocs(
  app: FastifyInstance,
  apiVersion: string,
): Promise<void> {
  if (!env.apiDocsEnabled) {
    // Not registered at all — the routes 404 exactly as an unknown path does,
    // which does not confirm that docs exist here.
    app.log.info("API docs are disabled (API_DOCS_ENABLED / NODE_ENV=production).");
    return;
  }

  await app.register(fastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: `${PRODUCT_NAME} API`,
        version: apiVersion,
        description:
          "Multi-tenant ERP for Kenyan MSMEs. Every tenant's data lives in its own PostgreSQL schema and is reached only through the authenticated session's tenant context.\n\n" +
          "**Money is never a JSON number.** On input, money is a decimal string (`\"1250.00\"`); on output it is a string of integer minor units — KES cents (`\"125000\"`). A JSON number in a money field is rejected by the validator.\n\n" +
          "**Quantities and tax rates are decimal strings too**, and are NOT money.\n\n" +
          "Authenticate with `POST /v1/auth/login`, then send `Authorization: Bearer <accessToken>`.",
      },
      servers: [
        {
          url: `http://localhost:${env.port.toString()}`,
          description: "Local development",
        },
      ],
      tags: API_TAGS.map((tag) => ({ name: tag.name, description: tag.description })),
      components: {
        securitySchemes: {
          [BEARER_SCHEME]: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description:
              "Access token from POST /v1/auth/login. Carries the user, role and tenant; the tenant schema is derived from it and never from a request field.",
          },
        },
      },
    },
    transform: jsonSchemaTransform,
    // Schemas given an `id` via .meta({ id: "..." }) are registered in Zod's
    // global registry and emitted ONCE under components/schemas, referenced by
    // $ref elsewhere. Without this the $refs are generated but the components
    // are not, leaving the document unresolvable.
    transformObject: jsonSchemaTransformObject,
  });

  // In production the docs exist but are not anonymous. requireAuth is the same
  // gate every other authenticated route uses — no parallel auth logic.
  const uiOptions = env.isProduction
    ? { routePrefix: DOCS_ROUTE_PREFIX, staticCSP: DOCS_CSP, uiHooks: { onRequest: app.requireAuth } }
    : { routePrefix: DOCS_ROUTE_PREFIX, staticCSP: DOCS_CSP };

  await app.register(fastifySwaggerUi, uiOptions);

  if (env.isProduction) {
    app.log.warn(
      "API docs are ENABLED in production and require an authenticated session.",
    );
  }
}
