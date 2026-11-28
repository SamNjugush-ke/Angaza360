import { render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { vi } from "vitest";
import { Catalog } from "@/components/catalog/catalog";
import { DataProvider } from "@/components/providers/data-provider";
import { ToastProvider } from "@/components/toast/toast";
import type { Role } from "@/lib/auth/landing";
import type { Product } from "@/lib/catalog/types";

// Shared fixtures for the catalog tests: a product builder, a fetch stub that records each call
// to the BFF and answers from a list of routes, and the page rendered as the app renders it.

export interface Call {
  method: string;
  url: URL;
  /** JSON parsed; a text/csv body stays the raw string. */
  body: unknown;
  contentType: string | null;
}

export type Route = (call: Call) => Response | null;

export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const refusal = (status: number, message: string) => json(status, { statusCode: status, error: "Error", message });

export function product(over: Partial<Product> = {}): Product {
  return {
    id: "p-1",
    sku: "NKH-CEM-50",
    barcode: null,
    name: "Bamburi Cement 50kg",
    description: null,
    category: "Building",
    unitOfMeasure: "bag",
    imageUrl: null,
    costPrice: "69000",
    price: "84500",
    taxClass: "STANDARD_RATED",
    kind: "GOOD",
    stockCount: "140.000",
    minStockThreshold: "20.000",
    reorderQuantity: "100.000",
    avgCost: "69000",
    stockValue: "9660000",
    batchTracked: false,
    expiryDate: null,
    isActive: true,
    supplierId: null,
    createdAt: "2026-10-30T10:00:00.000Z",
    updatedAt: "2026-10-30T10:00:00.000Z",
    ...over,
  };
}

export const PAGE = Array.from({ length: 20 }, (_, i) => product({ id: `p-${i.toString()}`, sku: `SKU-${i.toString()}`, name: `Item ${i.toString()}` }));

export function listRoute(data: Product[] = PAGE, total = 45): Route {
  return (call) =>
    call.method === "GET" && call.url.pathname === "/api/v1/products"
      ? json(200, { data, pagination: { take: Number(call.url.searchParams.get("take")), skip: Number(call.url.searchParams.get("skip")), total } })
      : null;
}

export const categoriesRoute: Route = (call) =>
  call.method === "GET" && call.url.pathname === "/api/v1/products/categories" ? json(200, { data: ["Building", "Paint", "Services"] }) : null;

/** Stubs fetch; returns the live call log and route list (routes are tried in order). */
export function installFetch(): { calls: Call[]; routes: Route[] } {
  const state = { calls: [] as Call[], routes: [] as Route[] };
  document.cookie = "ag_csrf=csrf-token; path=/";
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const contentType = new Headers(init.headers).get("content-type");
    const call: Call = {
      method: init.method ?? "GET",
      url: new URL(input, "http://app.test"),
      body: typeof init.body === "string" ? (contentType === "text/csv" ? init.body : JSON.parse(init.body)) : undefined,
      contentType,
    };
    state.calls.push(call);
    for (const route of state.routes) {
      const answer = route(call);
      if (answer) return answer;
    }
    return json(404, { statusCode: 404, error: "Not Found", message: "unrouted" });
  });
  return state;
}

export function showCatalog(role: Role) {
  return render(
    <ToastProvider>
      <DataProvider>
        <main>
          <Catalog role={role} />
        </main>
      </DataProvider>
    </ToastProvider>,
  );
}

export async function catalogTable() {
  return within(await screen.findByRole("table"));
}

export async function axeViolations(): Promise<string[]> {
  document.documentElement.lang = "en-KE";
  document.title = "Products & services";
  const result = await axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
    rules: { "color-contrast": { enabled: false }, "target-size": { enabled: false }, region: { enabled: false } },
  });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}
