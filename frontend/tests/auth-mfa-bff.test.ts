import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as loginMfa } from "@/app/api/auth/login/mfa/route";
import { POST as loginPassword } from "@/app/api/auth/login/password/route";
import { POST as enrollStart } from "@/app/api/auth/login/mfa-enrollment/start/route";
import { POST as enrollConfirm } from "@/app/api/auth/login/mfa-enrollment/confirm/route";
import { GET as proxyGet, POST as proxyPost } from "@/app/api/v1/[...path]/route";

// THE STAGED SIGN-IN THROUGH THE BFF (M4.5 Wave 1). The challenge token is a bearer secret: it
// lives in an HttpOnly, SameSite=strict cookie scoped to /api/auth/login and NEVER reaches the
// browser's JavaScript — the body says only which step is next. The stage routes read it from
// the cookie (never the body), set the session exactly like a plain login when the last step is
// done, and drop the cookie when the backend says the challenge is dead.

const APP = "http://app.test";
const CHALLENGE = "challenge-token-0123456789abcdefghijklmnop";

interface BackendCall {
  path: string;
  body: unknown;
  authorization: string | null;
}

let calls: BackendCall[];
let routes: Record<string, () => Response>;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  calls = [];
  routes = {};
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    const text = await request.text();
    calls.push({ path, body: text ? JSON.parse(text) : undefined, authorization: request.headers.get("authorization") });
    const answer = routes[path];
    if (!answer) throw new TypeError(`fetch failed: no stub for ${path}`);
    return answer();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jwt(nonce: string): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "HS256" })}.${part({ sub: "u1", exp: Math.floor(Date.now() / 1000) + 900, n: nonce })}.sig`;
}
const ACCESS = jwt("a");
const AUTHENTICATED = {
  status: "AUTHENTICATED",
  accessToken: ACCESS,
  refreshToken: "refresh-token-value-0123456789",
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  user: { id: "u1", fullName: "Achieng Admin", email: "admin@angaza.test", role: "SUPER_ADMIN" },
  tenant: null,
};

function request(path: string, body: unknown, opts: { cookie?: string; origin?: string | null } = {}): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  const origin = opts.origin === undefined ? APP : opts.origin;
  if (origin !== null) headers.set("origin", origin);
  if (opts.cookie !== undefined) headers.set("cookie", opts.cookie);
  return new NextRequest(`${APP}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

interface SetCookie {
  value: string;
  attrs: Record<string, string | true>;
}

function setCookies(response: Response): Record<string, SetCookie> {
  const out: Record<string, SetCookie> = {};
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...rest] = line.split(";").map((s) => s.trim());
    const eq = pair.indexOf("=");
    const attrs: Record<string, string | true> = {};
    for (const attr of rest) {
      const i = attr.indexOf("=");
      if (i === -1) attrs[attr.toLowerCase()] = true;
      else attrs[attr.slice(0, i).toLowerCase()] = attr.slice(i + 1);
    }
    out[pair.slice(0, eq)] = { value: decodeURIComponent(pair.slice(eq + 1)), attrs };
  }
  return out;
}

const challengeCookie = (remember = false) => `ag_login_challenge=${remember ? "1" : "0"}.${CHALLENGE}`;

describe("a password that still owes a step", () => {
  it("answers ONLY the next step; the challenge goes into an HttpOnly, strict, login-scoped cookie; no session", async () => {
    routes["/v1/auth/login"] = () => json(200, { status: "MFA_REQUIRED", challengeToken: CHALLENGE, expiresAt: new Date().toISOString() });
    const response = await login(request("/api/auth/login", { email: "admin@angaza.test", password: "correct horse", remember: true }));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ status: "MFA_REQUIRED" });
    expect(text).not.toContain(CHALLENGE);
    const cookies = setCookies(response);
    expect(cookies.ag_login_challenge.value).toBe(`1.${CHALLENGE}`);
    expect(cookies.ag_login_challenge.attrs).toMatchObject({ httponly: true, samesite: "strict", path: "/api/auth/login" });
    expect(cookies.ag_session).toBeUndefined();
    expect(cookies.ag_refresh).toBeUndefined();
  });

  it("refuses a backend answer with neither a session nor a challenge", async () => {
    routes["/v1/auth/login"] = () => json(200, { status: "MFA_REQUIRED" });
    const response = await login(request("/api/auth/login", { email: "a@b.test", password: "x", remember: false }));
    expect(response.status).toBe(502);
    expect(setCookies(response).ag_login_challenge).toBeUndefined();
  });
});

describe("the MFA stage", () => {
  it("with no challenge cookie is the one 401, and the backend is never called", async () => {
    const response = await loginMfa(request("/api/auth/login/mfa", { code: "123456" }));
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("ChallengeInvalid");
    expect(calls).toHaveLength(0);
  });

  it("spends the challenge from the COOKIE — never one in the body — and sets the session on success", async () => {
    routes["/v1/auth/login/mfa"] = () => json(200, AUTHENTICATED);
    const response = await loginMfa(
      request("/api/auth/login/mfa", { code: " 123456 ", challengeToken: "attacker-supplied" }, { cookie: challengeCookie(true) }),
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ path: "/v1/auth/login/mfa", body: { challengeToken: CHALLENGE, code: "123456" }, authorization: null }]);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ status: "AUTHENTICATED", role: "SUPER_ADMIN" });
    expect(text).not.toContain(ACCESS);
    const cookies = setCookies(response);
    expect(cookies.ag_session.value).toBe(ACCESS);
    expect(cookies.ag_session.attrs.httponly).toBe(true);
    // "Keep me signed in" survives the step: persistent cookies.
    expect(cookies.ag_persist?.value).toBe("1");
    expect(cookies.ag_login_challenge.value).toBe("");
    expect(cookies.ag_login_challenge.attrs["max-age"]).toBe("0");
  });

  it("a wrong code keeps the challenge (the user tries again); a dead challenge drops it", async () => {
    routes["/v1/auth/login/mfa"] = () => json(401, { statusCode: 401, error: "InvalidCode", message: "That code is not valid." });
    const wrong = await loginMfa(request("/api/auth/login/mfa", { code: "000000" }, { cookie: challengeCookie() }));
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).error).toBe("InvalidCode");
    expect(setCookies(wrong).ag_login_challenge).toBeUndefined();

    routes["/v1/auth/login/mfa"] = () => json(401, { statusCode: 401, error: "ChallengeInvalid", message: "gone" });
    const dead = await loginMfa(request("/api/auth/login/mfa", { code: "000000" }, { cookie: challengeCookie() }));
    expect(dead.status).toBe(401);
    expect((await dead.json()).error).toBe("ChallengeInvalid");
    expect(setCookies(dead).ag_login_challenge.attrs["max-age"]).toBe("0");
  });

  it("refuses a cross-site request before anything else", async () => {
    const response = await loginMfa(request("/api/auth/login/mfa", { code: "123456" }, { cookie: challengeCookie(), origin: "https://evil.test" }));
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe("the forced new password and the admin enrolment", () => {
  it("a new password can lead to the next step, keeping the challenge", async () => {
    routes["/v1/auth/login/password"] = () =>
      json(200, { status: "MFA_ENROLLMENT_REQUIRED", challengeToken: CHALLENGE, expiresAt: new Date().toISOString() });
    const response = await loginPassword(request("/api/auth/login/password", { newPassword: "a-new-password-2026" }, { cookie: challengeCookie() }));
    expect(await response.json()).toEqual({ status: "MFA_ENROLLMENT_REQUIRED" });
    expect(calls[0]?.body).toEqual({ challengeToken: CHALLENGE, newPassword: "a-new-password-2026" });
    expect(setCookies(response).ag_login_challenge.value).toBe(`0.${CHALLENGE}`);
  });

  it("enrolment hands out the setup key once (no-store) and the backup codes beside the session", async () => {
    routes["/v1/auth/login/mfa-enrollment/start"] = () => json(200, { secret: "JBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP" });
    const start = await enrollStart(request("/api/auth/login/mfa-enrollment/start", {}, { cookie: challengeCookie() }));
    expect(start.headers.get("cache-control")).toBe("no-store");
    expect(await start.json()).toEqual({ secret: "JBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP" });

    routes["/v1/auth/login/mfa-enrollment/confirm"] = () => json(200, { backupCodes: ["ABCDE-FGHJK", "KMNPQ-RSTVW"], result: AUTHENTICATED });
    const confirm = await enrollConfirm(request("/api/auth/login/mfa-enrollment/confirm", { code: "123456" }, { cookie: challengeCookie() }));
    expect(confirm.status).toBe(200);
    expect(confirm.headers.get("cache-control")).toBe("no-store");
    const body = await confirm.json();
    expect(body).toMatchObject({ status: "AUTHENTICATED", backupCodes: ["ABCDE-FGHJK", "KMNPQ-RSTVW"] });
    expect(JSON.stringify(body)).not.toContain(ACCESS);
    expect(setCookies(confirm).ag_session.value).toBe(ACCESS);
  });

  it("rejects a malformed code before the backend", async () => {
    const response = await enrollConfirm(request("/api/auth/login/mfa-enrollment/confirm", { code: "12ab" }, { cookie: challengeCookie() }));
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("the data proxy's one /v1/auth exception", () => {
  function proxied(method: "GET" | "POST", path: string[]) {
    const headers = new Headers({ origin: APP, cookie: "ag_session=tok; ag_csrf=csrf-value", "x-csrf-token": "csrf-value", "content-type": "application/json" });
    const nextRequest = new NextRequest(`${APP}/api/v1/${path.join("/")}`, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) });
    const handler = method === "GET" ? proxyGet : proxyPost;
    return handler(nextRequest, { params: Promise.resolve({ path }) });
  }

  it("forwards your own /v1/auth/mfa settings with the bearer, and still refuses every other /v1/auth path", async () => {
    routes["/v1/auth/mfa"] = () => json(200, { enabled: false, required: false, enrolledAt: null, backupCodesRemaining: 0 });
    routes["/v1/auth/mfa/setup"] = () => json(200, { secret: "S", otpauthUri: "otpauth://x" });
    expect((await proxied("GET", ["auth", "mfa"])).status).toBe(200);
    expect((await proxied("POST", ["auth", "mfa", "setup"])).status).toBe(200);
    expect(calls.map((call) => [call.path, call.authorization])).toEqual([
      ["/v1/auth/mfa", "Bearer tok"],
      ["/v1/auth/mfa/setup", "Bearer tok"],
    ]);
    for (const path of [["auth", "sessions"], ["auth", "login", "mfa"], ["auth", "me"]]) {
      expect((await proxied("GET", path)).status).toBe(404);
    }
    expect(calls).toHaveLength(2);
  });
});
