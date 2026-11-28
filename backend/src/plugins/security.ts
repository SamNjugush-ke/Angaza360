// ===========================================================================
// Security baseline (Task T-A2): response headers + the rate-limit framework.
//
// Registered ONCE, directly on the root instance and BEFORE cors, docs and every
// route — the encapsulate:false pattern registerAuth uses. Both plugins below are
// fastify-plugin wrapped, so their hooks reach every route in the app: the public
// health probes, /docs, the M-Pesa webhook and every authenticated route alike.
//
// (a) HEADERS. This is a JSON API: it serves data and loads nothing, so the
//     Content-Security-Policy denies everything by default. The ONE exception is
//     the swagger-ui subtree, which src/plugins/docs.ts relaxes for its own routes
//     only. HSTS is 180 days with includeSubDomains and deliberately NO preload
//     (preload is a near-irreversible commitment for the whole domain).
//     Cross-Origin-Embedder-Policy stays OFF — it breaks swagger-ui.
//
// (b) RATE LIMITING. @fastify/rate-limit is registered here and NOWHERE else,
//     with `global: false`: a route is throttled only if it OPTS IN, by naming one
//     of the RATE_LIMITS tiers below. The one-line pattern for a future route:
//
//         config: { rateLimit: RATE_LIMITS.SENSITIVE },
//
//     A tier is spread when a route needs its own key or hook, e.g. login:
//     `{ ...RATE_LIMITS.AUTH, hook: "preHandler", keyGenerator }`.
//     The default hook is onRequest, so a throttled route counts a request BEFORE
//     authentication — an unauthenticated flood exhausts the budget too — and the
//     default key is the client IP.
//
//     A throttled request gets the project's ONE error shape
//     ({ statusCode, error, message } — see errorBody in schemas/common.ts) with a
//     Retry-After header, exactly like every other error the API returns.
// ===========================================================================

import type { FastifyInstance, FastifyRequest } from "fastify";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit, { type errorResponseBuilderContext } from "@fastify/rate-limit";
import { env } from "../config/env";
import { errorBody } from "../schemas/common";

export interface RateLimitTier {
  readonly max: number;
  readonly timeWindow: number;
}

export const RATE_LIMITS = Object.freeze({
  // Login and token refresh: credential guessing and token-replay surfaces.
  AUTH: Object.freeze({ max: env.loginRateLimitMax, timeWindow: env.loginRateLimitWindowMs }),
  // Expensive or high-value authenticated operations (secret writes, report generation).
  SENSITIVE: Object.freeze({
    max: env.sensitiveRateLimitMax,
    timeWindow: env.sensitiveRateLimitWindowMs,
  }),
  // The public M-Pesa callback webhook.
  WEBHOOK: Object.freeze({ max: 60, timeWindow: 60_000 }),
} satisfies Record<string, RateLimitTier>);

/** The error a throttled request is answered with: an Error whose fields ARE errorBody(). */
export class RateLimitExceededError extends Error {
  readonly statusCode: number;
  readonly error: string;

  constructor(statusCode: number, error: string, message: string) {
    super(message);
    this.name = "RateLimitExceededError";
    const body = errorBody(statusCode, error, message);
    this.statusCode = body.statusCode;
    this.error = body.error;
  }
}

function rateLimitResponse(
  _request: FastifyRequest,
  context: errorResponseBuilderContext,
): RateLimitExceededError {
  // The plugin THROWS what this returns, so it must be an Error carrying a
  // statusCode; the global error handler renders it as errorBody(429,
  // "TooManyRequests", message). Retry-After is set by the plugin before this runs.
  return new RateLimitExceededError(
    context.statusCode,
    "TooManyRequests",
    `Rate limit exceeded, retry in ${context.after}.`,
  );
}

export async function registerSecurity(app: FastifyInstance): Promise<void> {
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
      },
    },
    strictTransportSecurity: { maxAge: 15_552_000, includeSubDomains: true, preload: false },
    // X-Content-Type-Options: nosniff is helmet's default and is left on.
    xFrameOptions: { action: "deny" },
    referrerPolicy: { policy: "no-referrer" },
    crossOriginEmbedderPolicy: false,
  });

  await app.register(fastifyRateLimit, {
    global: false,
    errorResponseBuilder: rateLimitResponse,
  });
}
