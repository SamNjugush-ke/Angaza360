// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, setSessionExpiredHandler } from "@/lib/api/browser";

interface Sent {
  url: string;
  method: string;
  csrf: string | null;
}

let sent: Sent[];
let refreshAnswer: () => Response;
let dataAnswers: Response[];
const expired = vi.fn();

beforeEach(() => {
  sent = [];
  dataAnswers = [];
  refreshAnswer = () => new Response(null, { status: 204 });
  expired.mockReset();
  setSessionExpiredHandler(expired);
  document.cookie = "ag_csrf=token-1; path=/";
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    sent.push({ url, method: init.method ?? "GET", csrf: headers.get("x-csrf-token") });
    if (url === "/api/auth/refresh") {
      document.cookie = "ag_csrf=token-2; path=/"; // the BFF rotates it
      return refreshAnswer();
    }
    return dataAnswers.shift() ?? new Response("{}", { status: 200 });
  });
});

afterEach(() => vi.unstubAllGlobals());

const status = (code: number) => new Response(code === 204 ? null : "{}", { status: code });

describe("apiFetch", () => {
  it("calls the BFF proxy, with the CSRF header on mutations only", async () => {
    await apiFetch("/locations?activeOnly=true");
    await apiFetch("/expenses", { method: "POST", body: "{}" });
    expect(sent).toEqual([
      { url: "/api/v1/locations?activeOnly=true", method: "GET", csrf: null },
      { url: "/api/v1/expenses", method: "POST", csrf: "token-1" },
    ]);
  });

  it("refreshes ONCE for concurrent 401s, then retries each call with the rotated CSRF token", async () => {
    dataAnswers = [status(401), status(401), status(200), status(200)];
    const [a, b] = await Promise.all([apiFetch("/a", { method: "POST" }), apiFetch("/b", { method: "POST" })]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(sent.filter((s) => s.url === "/api/auth/refresh")).toHaveLength(1);
    expect(sent.find((s) => s.url === "/api/auth/refresh")?.csrf).toBe("token-1");
    expect(sent.slice(-2).map((s) => s.csrf)).toEqual(["token-2", "token-2"]);
    expect(expired).not.toHaveBeenCalled();
  });

  it("sends the user to sign in again when the refresh is refused", async () => {
    dataAnswers = [status(401)];
    refreshAnswer = () => status(401);
    const response = await apiFetch("/dashboard");
    expect(response.status).toBe(401);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("does not sign the user out when the refresh service is unavailable", async () => {
    dataAnswers = [status(401)];
    refreshAnswer = () => status(502);
    const response = await apiFetch("/dashboard");
    expect(response.status).toBe(401);
    expect(expired).not.toHaveBeenCalled();
  });

  it("passes other statuses straight through without refreshing", async () => {
    dataAnswers = [status(403)];
    expect((await apiFetch("/payroll/runs")).status).toBe(403);
    expect(sent.map((s) => s.url)).toEqual(["/api/v1/payroll/runs"]);
  });
});
