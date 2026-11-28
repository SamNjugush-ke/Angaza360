import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as status, PATCH as edit, POST as create } from "@/app/api/application/route";
import { PUT as upload } from "@/app/api/application/documents/[side]/route";
import { POST as open } from "@/app/api/application/open/route";
import { GET as options } from "@/app/api/application/options/route";
import { POST as submit } from "@/app/api/application/submit/route";

// THE APPLICANT'S BFF (M4.5 W2). The application's access token is a bearer secret: it must live
// ONLY in the HttpOnly, SameSite=strict cookie scoped to /api/application — never in a response
// body — and every write is Origin-checked. The backend is stubbed at fetch.

const APP = "http://app.test";
const TOKEN = "tok_0123456789abcdefghijklmnop";

interface BackendCall {
  path: string;
  method: string;
  token: string | null;
  contentType: string | null;
  forwardedFor: string | null;
}

let calls: BackendCall[];
let routes: Record<string, () => Response>;

const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });

beforeEach(() => {
  calls = [];
  routes = {};
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    calls.push({
      path,
      method: request.method,
      token: request.headers.get("x-application-token"),
      contentType: request.headers.get("content-type"),
      forwardedFor: request.headers.get("x-forwarded-for"),
    });
    const answer = routes[`${request.method} ${path}`];
    if (!answer) throw new TypeError(`fetch failed: no stub for ${request.method} ${path}`);
    return answer();
  });
});

afterEach(() => vi.unstubAllGlobals());

function request(
  path: string,
  opts: { method?: string; body?: BodyInit; json?: unknown; origin?: string | null; cookie?: string; contentType?: string } = {},
): NextRequest {
  const headers = new Headers({ "x-forwarded-for": "203.0.113.9" });
  const origin = opts.origin === undefined ? APP : opts.origin;
  if (origin !== null) headers.set("origin", origin);
  if (opts.cookie) headers.set("cookie", opts.cookie);
  let body = opts.body;
  if (opts.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(opts.json);
  } else if (opts.contentType) headers.set("content-type", opts.contentType);
  return new NextRequest(`${APP}${path}`, { method: opts.method ?? "POST", headers, body });
}

const withCookie = { cookie: `ag_application=${TOKEN}` };
const sideParams = (side: string) => ({ params: Promise.resolve({ side }) });

describe("starting an application", () => {
  it("keeps the access token ONLY in an HttpOnly, SameSite=strict cookie scoped to /api/application", async () => {
    routes["POST /v1/public/applications"] = () => json(201, { applicationId: "app-1", accessToken: TOKEN });
    const response = await create(request("/api/application", { json: { businessName: "Kilifi Fresh" } }));
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text)).toEqual({ applicationId: "app-1" });
    const cookie = response.headers.getSetCookie().join("\n");
    expect(cookie).toContain(`ag_application=${TOKEN}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=strict/i);
    expect(cookie).toMatch(/Path=\/api\/application/);
    expect(calls[0]?.forwardedFor).toBe("203.0.113.9");
  });

  it("passes the backend's field errors through and sets no cookie on a refusal", async () => {
    routes["POST /v1/public/applications"] = () =>
      json(400, { statusCode: 400, error: "BadRequest", message: "businessName: Taken.", errors: [{ field: "businessName", message: "Taken." }] });
    const response = await create(request("/api/application", { json: {} }));
    expect(response.status).toBe(400);
    expect((await response.json()).errors).toEqual([{ field: "businessName", message: "Taken." }]);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("refuses a cross-site Origin before calling the backend", async () => {
    expect((await create(request("/api/application", { json: {}, origin: "https://evil.test" }))).status).toBe(403);
    expect((await edit(request("/api/application", { method: "PATCH", json: {}, origin: "https://evil.test", ...withCookie }))).status).toBe(403);
    expect((await submit(request("/api/application/submit", { origin: "https://evil.test", ...withCookie }))).status).toBe(403);
    expect((await open(request("/api/application/open", { json: { token: TOKEN }, origin: "https://evil.test" }))).status).toBe(403);
    expect(
      (await upload(request("/api/application/documents/FRONT", { method: "PUT", body: new Uint8Array(4), contentType: "image/png", origin: "https://evil.test", ...withCookie }), sideParams("FRONT")))
        .status,
    ).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe("the open application", () => {
  it("reads, edits and submits with the token from the cookie, sent as the backend header", async () => {
    routes["GET /v1/public/applications/current"] = () => json(200, { status: "DRAFT" });
    routes["PATCH /v1/public/applications/current"] = () => new Response(null, { status: 204 });
    routes["POST /v1/public/applications/current/submit"] = () => json(202, { message: "Received." });
    expect((await status(request("/api/application", { method: "GET", ...withCookie }))).status).toBe(200);
    expect((await edit(request("/api/application", { method: "PATCH", json: { county: "Kilifi" }, ...withCookie }))).status).toBe(204);
    expect((await submit(request("/api/application/submit", withCookie))).status).toBe(202);
    expect(calls.map((c) => c.token)).toEqual([TOKEN, TOKEN, TOKEN]);
  });

  it("is a 404 without the cookie — a token in the body is never used", async () => {
    const response = await edit(request("/api/application", { method: "PATCH", json: { accessToken: TOKEN } }));
    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("forwards an ID side as the raw file, after screening its type, size and side", async () => {
    routes["PUT /v1/public/applications/current/documents/FRONT"] = () =>
      json(201, { side: "FRONT", contentType: "image/jpeg", byteSize: 4, uploadedAt: "2026-11-16T08:00:00.000Z" });
    const ok = await upload(
      request("/api/application/documents/FRONT", { method: "PUT", body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), contentType: "image/jpeg", ...withCookie }),
      sideParams("FRONT"),
    );
    expect(ok.status).toBe(201);
    expect(calls[0]).toMatchObject({ contentType: "image/jpeg", token: TOKEN });
    const html = await upload(request("/api/application/documents/FRONT", { method: "PUT", body: "<html>", contentType: "text/html", ...withCookie }), sideParams("FRONT"));
    expect(html.status).toBe(415);
    const big = await upload(
      request("/api/application/documents/BACK", { method: "PUT", body: new Uint8Array(5 * 1024 * 1024 + 1), contentType: "image/png", ...withCookie }),
      sideParams("BACK"),
    );
    expect(big.status).toBe(413);
    const side = await upload(request("/api/application/documents/SELFIE", { method: "PUT", body: new Uint8Array(4), contentType: "image/png", ...withCookie }), sideParams("SELFIE"));
    expect(side.status).toBe(404);
    expect(calls).toHaveLength(1);
  });
});

describe("opening the status link", () => {
  it("checks the link's token with the backend, then moves it into the cookie", async () => {
    routes["GET /v1/public/applications/current"] = () => json(200, { status: "SUBMITTED" });
    const response = await open(request("/api/application/open", { json: { token: TOKEN } }));
    expect(response.status).toBe(204);
    expect(calls[0]?.token).toBe(TOKEN);
    expect(response.headers.getSetCookie().join("\n")).toMatch(/ag_application=.*HttpOnly/i);
  });

  it("sets no cookie for a token the backend does not know", async () => {
    routes["GET /v1/public/applications/current"] = () => json(404, { statusCode: 404, error: "NotFound", message: "Not found." });
    const response = await open(request("/api/application/open", { json: { token: TOKEN } }));
    expect(response.status).toBe(404);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe("the form's options", () => {
  it("relays the counties and limits", async () => {
    routes["GET /v1/public/onboarding-options"] = () =>
      json(200, { counties: ["Kilifi"], businessStructures: [], taxRegimes: [], tiers: [], maxDocumentBytes: 5242880 });
    const response = await options(request("/api/application/options", { method: "GET" }));
    expect((await response.json()).counties).toEqual(["Kilifi"]);
  });
});
