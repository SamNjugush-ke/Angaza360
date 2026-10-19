// ===========================================================================
// THE M-PESA WEBHOOK GATE SURVIVES T-A2 (the engineering ledger "External Integrations").
//
// Moving the webhook onto the app-wide rate limiter must not change the 3.3 / G.3
// ordering: a WRONG path secret is a bare 404 — never a 400 that would reveal the
// endpoint by validating its body, and never a 429 on a single call. The control
// proves the 404 is the gate and not a missing route: with the RIGHT secret the same
// malformed body reaches validation and is a 400.
// ===========================================================================

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../../src/config/env";
import { buildServer } from "../../src/server";
import { FIXTURE_SUBDOMAIN } from "../setup/tenant";
import { freshIp } from "./http-app";

const WELL_FORMED = {
  Body: { stkCallback: { CheckoutRequestID: "ws_CO_T_A2_UNKNOWN", ResultCode: 1032, ResultDesc: "Cancelled" } },
};

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function webhookUrl(secret: string): string {
  return `/v1/webhooks/mpesa/${secret}/${FIXTURE_SUBDOMAIN}`;
}

describe("M-Pesa webhook path-secret gate", () => {
  it("a wrong path secret with a well-formed callback is 404 Not found", async () => {
    const response = await app.inject({
      method: "POST",
      url: webhookUrl("definitely-not-the-secret"),
      remoteAddress: freshIp(),
      payload: WELL_FORMED,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Not found" });
  });

  it("a wrong path secret with a MALFORMED body is still 404 — the gate runs before body validation", async () => {
    const response = await app.inject({
      method: "POST",
      url: webhookUrl("definitely-not-the-secret"),
      remoteAddress: freshIp(),
      payload: { not: "a callback" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Not found" });
  });

  it("control: the RIGHT secret with the same malformed body reaches validation (400, the one error shape)", async () => {
    const response = await app.inject({
      method: "POST",
      url: webhookUrl(env.mpesa.callbackPathSecret),
      remoteAddress: freshIp(),
      payload: { not: "a callback" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ statusCode: 400, error: "BadRequest" });
  });
});
