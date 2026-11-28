import { render } from "@testing-library/react";
import { vi } from "vitest";
import { Till } from "@/components/pos/till";
import { DataProvider } from "@/components/providers/data-provider";
import { LocationProvider } from "@/components/shell/location";
import { ToastProvider } from "@/components/toast/toast";
import type { Role } from "@/lib/auth/landing";
import { LOCATION_COOKIE } from "@/lib/location/selection";
import type { Product } from "@/lib/catalog/types";
import type { Customer, Quote, Receipt, ShiftSummary } from "@/lib/pos/types";
import { product } from "./catalog";

// Shared fixtures for the till tests: the BFF stubbed at fetch (each call recorded, answered by
// the first route that claims it), and the till rendered inside the app's real providers.

export interface Call {
  method: string;
  url: URL;
  body: unknown;
}
export type Route = (call: Call) => Response | null;

export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const refusal = (status: number, message: string) => json(status, { statusCode: status, error: "Error", message });

export const MAIN = { id: "loc-main", name: "Main store", code: "MAIN", type: "MAIN", isDefault: true, isActive: true };
export const TILL = { id: "loc-till", name: "Till 1", code: "TILL-1", type: "POS", isDefault: false, isActive: true };

export function shift(over: Partial<ShiftSummary> = {}): ShiftSummary {
  return {
    id: "shift-1",
    cashierId: "user-1",
    status: "OPEN",
    openingFloat: "100000",
    closingFloat: null,
    expectedCash: null,
    variance: null,
    openedAt: "2026-11-05T06:30:00.000Z",
    closedAt: null,
    locationId: TILL.id,
    cashierAssigned: true,
    saleCount: 3,
    gross: "450000",
    tenderBreakdown: { CASH: "300000", MPESA: "0", BANK_TRANSFER: "100000", CREDIT: "50000" },
    ...over,
  };
}

export const CEMENT: Product = product({ id: "p-cem", sku: "NKH-CEM-50", barcode: "6001234500012", name: "Bamburi Cement 50kg", price: "84500", unitOfMeasure: "bag" });
export const NAILS: Product = product({ id: "p-nai", sku: "NKH-NAI-4", name: "Wire Nails 4in", price: "22000", unitOfMeasure: "kg" });
export const DELIVERY: Product = product({ id: "p-del", sku: "NKH-SVC-DEL", name: "Delivery", kind: "SERVICE", price: "50000", stockCount: "0.000" });
const BY_ID = new Map([CEMENT, NAILS, DELIVERY].map((item) => [item.id, item]));

/** The server's quote for a body — figures as a Turnover-Tax tenant prices them (all D, no VAT). */
export function quoteFor(body: { lines: Array<{ productId: string; quantity: string; discount?: string }>; sellingLocationId?: string }, sellable = "50.000"): Quote {
  const lines = body.lines.map((line, index) => {
    const item = BY_ID.get(line.productId) ?? CEMENT;
    const [whole = "0", fraction = ""] = line.quantity.split(".");
    const milli = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, "0"));
    const gross = (BigInt(item.price) * milli + 500n) / 1000n;
    const [dWhole = "0", dFraction = ""] = (line.discount ?? "0").split(".");
    const discount = BigInt(dWhole) * 100n + BigInt(dFraction.padEnd(2, "0"));
    const net = gross - discount;
    return {
      lineNumber: index + 1,
      productId: item.id,
      sku: item.sku,
      name: item.name,
      kind: item.kind,
      quantity: line.quantity,
      unitPrice: item.price,
      discount: discount.toString(),
      taxClass: item.taxClass,
      taxCode: "D" as const,
      vatRate: "0",
      lineNet: net.toString(),
      lineVat: "0",
      lineTotal: net.toString(),
      sellable: item.kind === "GOOD" ? sellable : null,
    };
  });
  const total = lines.reduce((sum, line) => sum + BigInt(line.lineNet), 0n).toString();
  return { sellingLocationId: body.sellingLocationId ?? MAIN.id, lines, subtotal: total, vatTotal: "0", total };
}

export function customer(over: Partial<Customer> = {}): Customer {
  return {
    id: "c-1",
    name: "Kiptoo Hardware",
    phone: "0712345678",
    email: null,
    kraPin: null,
    loyaltyPoints: 12,
    creditLimit: "1000000",
    creditBalance: "250000",
    isActive: true,
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z",
    ...over,
  };
}

export const CUSTOMERS = [customer(), customer({ id: "c-2", name: "Wanjiru Builders", phone: "0722000000", creditLimit: "0", creditBalance: "0" }), customer({ id: "c-3", name: "Old Client", isActive: false })];

export function receipt(over: Partial<Receipt> = {}): Receipt {
  return {
    business: { name: "Nakuru Hardware", subdomain: "nakuru-hardware", kraPin: "P051234567X", legalName: "Nakuru Hardware Ltd", addressLine: "Kenyatta Ave, Nakuru", phone: "0700111222", email: null, brandPrimaryColor: "#006078", logoUrl: null },
    footer: "Asante — karibu tena!",
    saleNumber: "SALE-20261105-000004",
    timestamp: "2026-11-05T07:15:00.000Z",
    status: "COMPLETED",
    lines: [{ description: "Bamburi Cement 50kg (NKH-CEM-50)", quantity: "2.000", unitPrice: "84500", discount: "5000", vatRate: "0", taxCode: "D", lineNet: "164000", lineVat: "0", lineTotal: "164000" }],
    vatSummary: { subtotal: "164000", vatTotal: "0", total: "164000" },
    taxCodeSummary: [{ code: "D", label: "No VAT — not VAT registered", rate: "0.00", vatableAmount: "164000", vatAmount: "0" }],
    tenders: [{ tenderType: "CASH", amount: "164000", status: "CONFIRMED" }],
    amountTendered: "200000",
    changeDue: "36000",
    customer: null,
    etims: { fiscalStatus: "NOT_REQUESTED", invoiceNumber: null, kraReceiptNumber: null, rcptSign: null, intrlData: null, sdcDateTime: null, qrCode: null },
    ...over,
  };
}

/** Stubs fetch with the till's default routes plus any given first; returns the live call log. */
export function installPosFetch(extra: Route[] = []): { calls: Call[]; routes: Route[] } {
  const state = { calls: [] as Call[], routes: [...extra] as Route[] };
  const defaults: Route[] = [
    (call) => (call.url.pathname === "/api/v1/locations" ? json(200, { data: [MAIN, TILL] }) : null),
    (call) => (call.url.pathname === "/api/v1/pos/shifts/current" ? json(200, shift()) : null),
    // A cashier is assigned to Till 1 (M4.5 W3); owners and managers are not restricted.
    (call) =>
      call.url.pathname === "/api/v1/pos/my-location"
        ? json(200, { restricted: true, location: { id: TILL.id, code: TILL.code, name: TILL.name, type: TILL.type }, lowStock: [], myRequests: [] })
        : null,
    (call) => (call.url.pathname === "/api/v1/pos/shifts/shift-1/summary" ? json(200, shift()) : null),
    (call) => {
      if (call.url.pathname !== "/api/v1/products") return null;
      const q = (call.url.searchParams.get("q") ?? "").toLowerCase();
      const data = [CEMENT, NAILS, DELIVERY].filter((item) => item.name.toLowerCase().includes(q) || item.sku.toLowerCase().includes(q) || (item.barcode ?? "") === q);
      return json(200, { data, pagination: { take: 20, skip: 0, total: data.length } });
    },
    (call) => (call.method === "POST" && call.url.pathname === "/api/v1/pos/sales/quote" ? json(200, quoteFor(call.body as Parameters<typeof quoteFor>[0])) : null),
    (call) => (call.method === "GET" && call.url.pathname === "/api/v1/customers" ? json(200, { data: CUSTOMERS }) : null),
  ];
  document.cookie = "ag_csrf=csrf-token; path=/";
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const call: Call = { method: init.method ?? "GET", url: new URL(input, "http://app.test"), body: typeof init.body === "string" ? JSON.parse(init.body) : undefined };
    state.calls.push(call);
    for (const route of [...state.routes, ...defaults]) {
      const answer = route(call);
      if (answer) return answer;
    }
    return json(404, { statusCode: 404, error: "Not Found", message: "unrouted" });
  });
  return state;
}

/** The cashier has chosen a location (the cookie the location selector writes). */
export function chooseLocation(id: string | null) {
  document.cookie = id === null ? `${LOCATION_COOKIE}=; path=/; max-age=0` : `${LOCATION_COOKIE}=${id}; path=/`;
}

export function showTill(role: Role = "CASHIER") {
  return render(
    <ToastProvider>
      <DataProvider>
        <LocationProvider enabled>
          <main>
            <Till role={role} />
          </main>
        </LocationProvider>
      </DataProvider>
    </ToastProvider>,
  );
}

/**
 * The pre-sale M-Pesa STK, simulated like the backend's dev provider: a push is INITIATED until
 * the dev deliver route (POST /v1/dev/mpesa/deliver) answers it, as the real callback would. A
 * test drives the outcome through that route exactly as the live check does.
 */
export function installStk(routes: Route[]) {
  const pushes = new Map<string, { amount: string; status: string; receipt: string | null; resultDesc: string | null }>();
  let n = 0;
  routes.push((call) => {
    if (call.method !== "POST" || call.url.pathname !== "/api/v1/pos/mpesa/stk-push") return null;
    n += 1;
    const id = `ws_CO_${n.toString()}`;
    const body = call.body as { amount: string };
    const [whole = "0", fraction = ""] = body.amount.split(".");
    pushes.set(id, { amount: (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"))).toString(), status: "INITIATED", receipt: null, resultDesc: null });
    return json(201, { checkoutRequestId: id, mpesaTransactionId: `mtx-${n.toString()}`, status: "INITIATED" });
  });
  routes.push((call) => {
    if (call.method !== "POST" || call.url.pathname !== "/api/v1/dev/mpesa/deliver") return null;
    const body = call.body as { checkoutRequestId: string; outcome: "success" | "failure" };
    const push = pushes.get(body.checkoutRequestId);
    if (!push) return refusal(404, "No such M-Pesa transaction in this tenant.");
    if (body.outcome === "success") Object.assign(push, { status: "CALLBACK_OK", receipt: `QK${body.checkoutRequestId.slice(-1)}ABC1234` });
    else Object.assign(push, { status: "CALLBACK_FAILED", resultDesc: "Request cancelled by user" });
    return json(200, { delivered: true, webhookStatus: 200, webhookBody: {} });
  });
  routes.push((call) => {
    const match = /^\/api\/v1\/pos\/mpesa\/([^/]+)$/.exec(call.url.pathname);
    if (call.method !== "GET" || !match?.[1]) return null;
    const push = pushes.get(match[1]);
    if (!push) return refusal(404, "No M-Pesa transaction with that id.");
    return json(200, {
      checkoutRequestId: match[1],
      status: push.status,
      amount: push.amount,
      resultCode: push.status === "CALLBACK_OK" ? 0 : push.status === "INITIATED" ? null : 1032,
      resultDesc: push.resultDesc,
      mpesaReceiptNumber: push.receipt,
      saleId: null,
      tenderId: null,
    });
  });
  return {
    pushes,
    /** What the dev deliver route does: M-Pesa's answer, through the API. */
    deliver: (checkoutRequestId: string, outcome: "success" | "failure") =>
      fetch("/api/v1/dev/mpesa/deliver", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ checkoutRequestId, outcome }) }),
    /** The server's sweep timing an unanswered push out. */
    timeOut: (checkoutRequestId: string) => {
      const push = pushes.get(checkoutRequestId);
      if (push) push.status = "TIMED_OUT";
    },
  };
}
