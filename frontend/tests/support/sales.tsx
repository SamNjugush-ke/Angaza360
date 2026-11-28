import { render } from "@testing-library/react";
import { Sales } from "@/components/sales/sales";
import { DataProvider } from "@/components/providers/data-provider";
import { LocationProvider } from "@/components/shell/location";
import { ToastProvider } from "@/components/toast/toast";
import type { Role } from "@/lib/auth/landing";
import { toBusinessDate } from "@/lib/datetime";
import type { SaleRecord } from "@/lib/pos/types";
import { CUSTOMERS, json, MAIN, refusal, TILL, type Call, type Route } from "./pos";

// Fixtures for the Sales & receipts tests: sales shaped exactly as GET /v1/pos/sales returns them,
// and a fake list route that filters and pages them the way the server does (q on the sale
// number, status, customer, shift, business-day from/to), so a test asserts both the query the
// screen sent and what it shows.

const DAY_MS = 86_400_000;

export function sale(n: number, over: Partial<SaleRecord> = {}): SaleRecord {
  const number = `SALE-20261105-${n.toString().padStart(6, "0")}`;
  return {
    id: `sale-${n.toString()}`,
    saleNumber: number,
    shiftId: "shift-1",
    customerId: null,
    status: "COMPLETED",
    paymentStatus: "FULLY_SETTLED",
    subtotal: "84500",
    vatTotal: "0",
    total: "84500",
    cogsTotal: "60000",
    saleJournalEntryId: `je-${n.toString()}`,
    totAccrued: "2535",
    voidedByEntryId: null,
    voidReason: null,
    reference: null,
    createdBy: "user-1",
    createdAt: new Date(Date.now() - n * 1_000).toISOString(),
    sellingLocationId: TILL.id,
    origin: "ONLINE",
    businessTimestamp: null,
    syncedAt: null,
    deviceId: null,
    idempotencyKey: null,
    originalBusinessDate: null,
    fiscalStatus: "NOT_REQUESTED",
    lines: [
      {
        lineNumber: 1,
        productId: "p-cem",
        sku: "NKH-CEM-50",
        name: "Bamburi Cement 50kg",
        quantity: "1.000",
        unitPrice: "84500",
        discount: "0",
        vatRate: "0.00",
        taxClass: "STANDARD_RATED",
        taxCode: "D",
        lineNet: "84500",
        lineVat: "0",
        lineTotal: "84500",
        unitCogs: "60000",
        lineCogs: "60000",
      },
    ],
    tenders: [{ id: `t-${n.toString()}`, tenderType: "CASH", amount: "84500", status: "CONFIRMED", mpesaReference: null, mpesaTransactionId: null, mpesaChannel: null, cashReceived: "100000" }],
    ...over,
  } as SaleRecord;
}

/** Today's sales plus one from ten days ago; customers and tenders varied. */
export function standardSales(): SaleRecord[] {
  return [
    sale(1, { customerId: "c-1", tenders: [{ id: "t-1", tenderType: "MPESA", amount: "84500", status: "CONFIRMED", mpesaReference: "QK7AB12CDE", mpesaTransactionId: null, mpesaChannel: "TILL", cashReceived: null }] }),
    sale(2, { status: "VOIDED", voidReason: "Customer changed their mind", voidedByEntryId: "je-v2" }),
    sale(3, { customerId: "c-2" }),
    sale(4, {
      tenders: [
        { id: "t-4a", tenderType: "CASH", amount: "50000", status: "CONFIRMED", mpesaReference: null, mpesaTransactionId: null, mpesaChannel: null, cashReceived: "50000" },
        { id: "t-4b", tenderType: "MPESA", amount: "34500", status: "CONFIRMED", mpesaReference: "SIM6B0E4315", mpesaTransactionId: "mtx-1", mpesaChannel: "STK", cashReceived: null },
      ],
    }),
    sale(9, { shiftId: "shift-0", createdAt: new Date(Date.now() - 10 * DAY_MS).toISOString() }),
  ];
}

/** The list route, filtering and paging like the server. */
export function salesRoute(all: () => readonly SaleRecord[]): Route {
  return (call: Call) => {
    if (call.method !== "GET" || call.url.pathname !== "/api/v1/pos/sales") return null;
    const p = call.url.searchParams;
    const q = (p.get("q") ?? "").toLowerCase();
    const day = (s: SaleRecord) => toBusinessDate(s.businessTimestamp ?? s.createdAt);
    const rows = all().filter(
      (s) =>
        (q === "" || s.saleNumber.toLowerCase().includes(q)) &&
        (!p.get("status") || s.status === p.get("status")) &&
        (!p.get("customerId") || s.customerId === p.get("customerId")) &&
        (!p.get("shiftId") || s.shiftId === p.get("shiftId")) &&
        (!p.get("from") || day(s) >= (p.get("from") ?? "")) &&
        (!p.get("to") || day(s) <= (p.get("to") ?? "")),
    );
    const take = Number(p.get("take") ?? "25");
    const skip = Number(p.get("skip") ?? "0");
    return json(200, { data: rows.slice(skip, skip + take), pagination: { take, skip, total: rows.length } });
  };
}

export const listCalls = (calls: readonly Call[]) => calls.filter((call) => call.method === "GET" && call.url.pathname === "/api/v1/pos/sales");
export const lastListQuery = (calls: readonly Call[]) => Object.fromEntries(listCalls(calls).at(-1)?.url.searchParams.entries() ?? []);

/** The till routes the screen reads besides the list: customers, locations, the open shift. */
export function screenRoutes(openShift: boolean): Route[] {
  return [
    (call) => (call.url.pathname === "/api/v1/customers" ? json(200, { data: CUSTOMERS }) : null),
    (call) => (call.url.pathname === "/api/v1/locations" ? json(200, { data: [MAIN, TILL] }) : null),
    (call) =>
      call.url.pathname === "/api/v1/pos/shifts/current"
        ? openShift
          ? json(200, { id: "shift-1", status: "OPEN", openedAt: new Date().toISOString() })
          : refusal(404, "No open shift.")
        : null,
  ];
}

export function showSales(role: Role = "MSME_OWNER") {
  return render(
    <ToastProvider>
      <DataProvider>
        <LocationProvider enabled>
          <main>
            <Sales role={role} />
          </main>
        </LocationProvider>
      </DataProvider>
    </ToastProvider>,
  );
}
