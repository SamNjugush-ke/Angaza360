import { afterEach, describe, expect, it } from "vitest";
import { createApiClient } from "@/lib/api/client";
import { DEFAULT_API_BASE_URL, apiBaseUrl } from "@/lib/api/config";
import { ApiRequestError, apiErrorOf, isApiErrorBody, unwrap } from "@/lib/api/errors";
import { formatKES } from "@/lib/money";

interface Recorded {
  url: string;
  method: string;
  headers: Headers;
}

function stubFetch(status: number, body: unknown, recorded: Recorded[] = []): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    recorded.push({ url: request.url, method: request.method, headers: request.headers });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
}

const DASHBOARD = {
  period: { from: "2026-10-01", to: "2026-10-30" },
  revenue: "248050000",
  costOfSales: "100000",
  grossProfit: "247950000",
  operatingExpenses: "6300",
  netProfit: "247943700",
  cashPosition: { total: "9007199254740993", accounts: [{ code: "1000", name: "Cash on Hand", amount: "9007199254740993" }] },
  receivables: "5469600",
  payables: "0",
  topExpenseCategories: [],
  lowStockCount: 2,
};

describe("apiBaseUrl", () => {
  const saved = process.env.API_BASE_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = saved;
  });

  it("defaults to the local backend and honours API_BASE_URL", () => {
    delete process.env.API_BASE_URL;
    expect(apiBaseUrl()).toBe(DEFAULT_API_BASE_URL);
    process.env.API_BASE_URL = "https://api.example.test";
    expect(apiBaseUrl()).toBe("https://api.example.test");
  });
});

describe("createApiClient", () => {
  it("calls the typed path on the base URL with the given headers", async () => {
    const recorded: Recorded[] = [];
    const api = createApiClient({
      baseUrl: "http://backend.test",
      fetch: stubFetch(200, DASHBOARD, recorded),
      headers: { authorization: "Bearer test" },
    });
    const result = await api.GET("/v1/dashboard/", { params: { query: { year: 2026, month: 10 } } });

    expect(recorded).toHaveLength(1);
    expect(recorded[0].method).toBe("GET");
    expect(recorded[0].url).toBe("http://backend.test/v1/dashboard/?year=2026&month=10");
    expect(recorded[0].headers.get("authorization")).toBe("Bearer test");

    const dashboard = unwrap(result);
    // Money stays a string of cents end to end — even beyond 2^53.
    expect(typeof dashboard.cashPosition.total).toBe("string");
    expect(formatKES(dashboard.cashPosition.total, { currency: true })).toBe("KES 90,071,992,547,409.93");
    expect(formatKES(dashboard.revenue, { currency: true })).toBe("KES 2,480,500.00");
  });

  it("surfaces the backend error envelope", async () => {
    const envelope = { statusCode: 403, error: "Forbidden", message: "Role CASHIER may not read the dashboard." };
    const api = createApiClient({ baseUrl: "http://backend.test", fetch: stubFetch(403, envelope) });
    const result = await api.GET("/v1/dashboard/");

    expect(apiErrorOf(result)).toEqual(envelope);
    expect(() => unwrap(result)).toThrow(ApiRequestError);
    try {
      unwrap(result);
    } catch (err) {
      expect(err).toBeInstanceOf(ApiRequestError);
      const failure = err as ApiRequestError;
      expect(failure.status).toBe(403);
      expect(failure.body).toEqual(envelope);
      expect(failure.message).toBe("Forbidden: Role CASHIER may not read the dashboard.");
    }
  });

  it("reports a non-envelope failure by status alone", async () => {
    const api = createApiClient({ baseUrl: "http://backend.test", fetch: stubFetch(502, { upstream: "down" }) });
    const result = await api.GET("/v1/dashboard/");
    expect(apiErrorOf(result)).toBeNull();
    expect(() => unwrap(result)).toThrow("API request failed with HTTP 502");
  });
});

describe("isApiErrorBody", () => {
  it("accepts only the envelope shape", () => {
    expect(isApiErrorBody({ statusCode: 400, error: "BadRequest", message: "x" })).toBe(true);
    expect(isApiErrorBody({ statusCode: "400", error: "BadRequest", message: "x" })).toBe(false);
    expect(isApiErrorBody({ error: "BadRequest" })).toBe(false);
    expect(isApiErrorBody(null)).toBe(false);
    expect(isApiErrorBody("Forbidden")).toBe(false);
  });
});
