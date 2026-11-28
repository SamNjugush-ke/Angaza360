import { render } from "@testing-library/react";
import { vi } from "vitest";
import { DataProvider } from "@/components/providers/data-provider";
import { LocationProvider } from "@/components/shell/location";
import { Tax } from "@/components/tax/tax";
import { ToastProvider } from "@/components/toast/toast";
import type { Role } from "@/lib/auth/landing";
import { json, refusal, type Call } from "./money";

// A fake eTIMS + VAT-return server for the KRA eTIMS & tax tests. It holds whether the business
// has stored eTIMS credentials and initialized its device (and refuses with the API's own words
// when it has not), the fiscal invoices, three completed sales (one not filed, one signed, one
// whose invoice KRA rejected), signing / resubmitting / credit notes, and the tax position for
// the regime given.

type Status = "PENDING" | "SIGNED" | "REJECTED" | "QUEUED" | "FAILED";
interface Invoice {
  id: string;
  saleId: string;
  saleNumber: string;
  invoiceType: "SALE" | "CREDIT_NOTE";
  originalInvoiceId: string | null;
  etimsInvoiceNumber: number;
  status: Status;
  kraReceiptNumber: string | null;
  rcptSign: string | null;
  intrlData: string | null;
  sdcDateTime: string | null;
  qrCodeUrl: string | null;
  resultCode: string | null;
  resultMsg: string | null;
  retryCount: number;
}

export interface TaxServer {
  calls: Call[];
  routes: Array<(call: Call) => Response | null>;
  invoices: Invoice[];
  sales: Array<{ id: string; saleNumber: string; total: string; fiscalStatus: string }>;
}

export const NOT_CONFIGURED =
  "This tenant has no active eTIMS credentials. eTIMS invoices are signed under the TENANT's own KRA PIN and OSCU device — there is no shared signer to fall back to. Store the credentials under /v1/integrations/ETIMS and initialize the device. Sales continue to finalize normally without eTIMS.";

export function installTaxServer(options: { configured?: boolean; regime?: "VAT_REGISTERED" | "TURNOVER_TAX"; signOutcome?: Status } = {}): TaxServer {
  const configured = options.configured ?? true;
  const regime = options.regime ?? "VAT_REGISTERED";
  let device: Record<string, unknown> | null = configured ? { id: "dev-1", tin: "P051234567X", bhfId: "00", dvcSrlNo: "DVC-NKH-01", initialized: true, lastInitAt: "2026-10-02T07:00:00.000Z", lastInvoiceNo: 2, createdAt: "2026-10-02T07:00:00.000Z", updatedAt: "2026-10-02T07:00:00.000Z" } : null;
  const artefacts = (n: number) => ({ kraReceiptNumber: `KRA-RCPT-${n.toString()}`, rcptSign: `SIGN${n.toString()}ABCDEF0123456789`, intrlData: `INTRL${n.toString()}XYZ`, sdcDateTime: "20261105143000", qrCodeUrl: `https://etims-sbx.kra.go.ke/common/link/etims/receipt/indexEtimsReceiptData?Data=P051234567X00${n.toString()}`, resultCode: "000", resultMsg: "It is succeeded" });
  const invoices: Invoice[] = [
    { id: "inv-1", saleId: "s-5", saleNumber: "SALE-20261105-000005", invoiceType: "SALE", originalInvoiceId: null, etimsInvoiceNumber: 1, status: "SIGNED", ...artefacts(1), retryCount: 0 },
    { id: "inv-2", saleId: "s-6", saleNumber: "SALE-20261105-000006", invoiceType: "SALE", originalInvoiceId: null, etimsInvoiceNumber: 2, status: "REJECTED", kraReceiptNumber: null, rcptSign: null, intrlData: null, sdcDateTime: null, qrCodeUrl: null, resultCode: "910", resultMsg: "Buyer PIN is invalid", retryCount: 1 },
  ];
  const sales = [
    { id: "s-4", saleNumber: "SALE-20261105-000004", total: "1360000", fiscalStatus: "NOT_REQUESTED" },
    { id: "s-5", saleNumber: "SALE-20261105-000005", total: "65000", fiscalStatus: "SIGNED" },
    { id: "s-6", saleNumber: "SALE-20261105-000006", total: "22000", fiscalStatus: "FAILED" },
  ];
  const server: TaxServer = { calls: [], routes: [], invoices, sales };
  const view = (i: Invoice) => ({ ...i, etimsDeviceId: "dev-1", lastAttemptAt: "2026-11-05T11:30:00.000Z", createdBy: "user-1", createdAt: "2026-11-05T11:30:00.000Z", updatedAt: "2026-11-05T11:30:00.000Z" });
  const fiscalOf = (s: Status) => (s === "SIGNED" ? "SIGNED" : s === "PENDING" || s === "QUEUED" ? "PENDING_ETIMS" : "FAILED");
  const next = () => invoices.reduce((n, i) => Math.max(n, i.etimsInvoiceNumber), 0) + 1;
  const ready = () => configured && device !== null && device.initialized === true;

  const answer = (call: Call): Response | null => {
    const path = call.url.pathname;
    const q = call.url.searchParams;
    if (path === "/api/v1/locations") return json(200, { data: [] });
    if (path === "/api/v1/etims/invoices") {
      const data = [...invoices]
        .reverse()
        .filter((i) => (!q.get("status") || i.status === q.get("status")) && (!q.get("invoiceType") || i.invoiceType === q.get("invoiceType")) && (!q.get("saleId") || i.saleId === q.get("saleId")))
        .map(view);
      return json(200, { data, count: data.length });
    }
    const retry = /^\/api\/v1\/etims\/invoices\/([^/]+)\/retry$/.exec(path);
    if (retry && call.method === "POST") {
      const i = invoices.find((x) => x.id === retry[1]);
      if (!i) return refusal(404, "Unknown eTIMS invoice.");
      if (i.status === "SIGNED") return refusal(409, `eTIMS invoice ${i.etimsInvoiceNumber.toString()} is already SIGNED and is a permanent fiscal record.`);
      if (!ready()) return refusal(400, NOT_CONFIGURED);
      Object.assign(i, { status: "SIGNED", ...artefacts(i.etimsInvoiceNumber), retryCount: i.retryCount + 1 });
      const sale = sales.find((s) => s.id === i.saleId);
      if (sale && i.invoiceType === "SALE") sale.fiscalStatus = "SIGNED";
      return json(200, view(i));
    }
    const one = /^\/api\/v1\/etims\/invoices\/([^/]+)$/.exec(path);
    if (one) {
      const i = invoices.find((x) => x.id === one[1]);
      return i ? json(200, view(i)) : refusal(404, "No eTIMS invoice with that id.");
    }
    const sign = /^\/api\/v1\/etims\/sales\/([^/]+)\/sign$/.exec(path);
    if (sign && call.method === "POST") {
      const sale = sales.find((s) => s.id === sign[1]);
      if (!sale) return refusal(404, "Unknown sale.");
      if (!ready()) return refusal(400, NOT_CONFIGURED);
      const existing = invoices.find((i) => i.saleId === sale.id && i.invoiceType === "SALE");
      if (existing?.status === "SIGNED") return json(200, { invoice: view(existing), fiscalStatus: "SIGNED", alreadySigned: true, providerName: "simulated" });
      const status = options.signOutcome ?? "SIGNED";
      const n = existing?.etimsInvoiceNumber ?? next();
      const made: Invoice = { id: existing?.id ?? `inv-${n.toString()}`, saleId: sale.id, saleNumber: sale.saleNumber, invoiceType: "SALE", originalInvoiceId: null, etimsInvoiceNumber: n, status, ...(status === "SIGNED" ? artefacts(n) : { kraReceiptNumber: null, rcptSign: null, intrlData: null, sdcDateTime: null, qrCodeUrl: null, resultCode: status === "REJECTED" ? "910" : null, resultMsg: status === "REJECTED" ? "Buyer PIN is invalid" : null }), retryCount: 0 };
      if (existing) Object.assign(existing, made);
      else invoices.push(made);
      sale.fiscalStatus = fiscalOf(status);
      return json(200, { invoice: view(made), fiscalStatus: sale.fiscalStatus, alreadySigned: false, providerName: "simulated" });
    }
    const credit = /^\/api\/v1\/etims\/sales\/([^/]+)\/credit-note$/.exec(path);
    if (credit && call.method === "POST") {
      const original = invoices.find((i) => i.saleId === credit[1] && i.invoiceType === "SALE");
      if (!original || original.status !== "SIGNED") return refusal(409, "A credit note reverses a FILED invoice.");
      const n = next();
      const made: Invoice = { id: `inv-${n.toString()}`, saleId: original.saleId, saleNumber: original.saleNumber, invoiceType: "CREDIT_NOTE", originalInvoiceId: original.id, etimsInvoiceNumber: n, status: "SIGNED", ...artefacts(n), retryCount: 0 };
      invoices.push(made);
      return json(200, { invoice: view(made), providerName: "simulated" });
    }
    if (path === "/api/v1/etims/device" && call.method === "GET") {
      return device ? json(200, device) : refusal(404, "No eTIMS device has been initialized for this tenant.");
    }
    if (path === "/api/v1/etims/device/initialize" && call.method === "POST") {
      if (!configured) return refusal(400, "This tenant has no active ETIMS credentials for the sandbox environment. Store the credentials and activate them before using the integration.");
      device = { ...(device ?? {}), initialized: true, lastInitAt: "2026-11-10T08:00:00.000Z" };
      return json(200, { device, keyStored: true, environment: "SANDBOX", providerName: "simulated" });
    }
    if (path === "/api/v1/pos/sales") {
      const needle = (q.get("q") ?? "").toLowerCase();
      const data = sales.filter((s) => s.saleNumber.toLowerCase().includes(needle)).map((s) => ({ ...s, businessTimestamp: null, createdAt: "2026-11-05T11:00:00.000Z", status: "COMPLETED" }));
      return json(200, { data, pagination: { total: data.length, skip: 0, take: 10 } });
    }
    if (path === "/api/v1/reports/vat-return") {
      const registered = regime === "VAT_REGISTERED";
      return json(200, {
        period: { from: "2026-11-01T00:00:00.000Z", to: "2026-11-10T00:00:00.000Z" },
        taxRegime: regime,
        isVatRegistered: registered,
        presentation: registered ? "VAT_RETURN" : "TOT_POSITION",
        vat: {
          outputVat: { charged: registered ? "1600000" : "0", reversed: registered ? "16000" : "0", net: registered ? "1584000" : "0" },
          inputVat: { claimed: registered ? "400000" : "0", reversed: "0", net: registered ? "400000" : "0" },
          netVat: registered ? "1184000" : "0",
          position: registered ? "PAYABLE" : "NIL",
          salesByCode: { standardRated: { turnover: registered ? "9900000" : "0", vat: registered ? "1584000" : "0" }, zeroRated: { turnover: "120000" }, exempt: { turnover: "50000" }, nonVat: { turnover: registered ? "0" : "100000" } },
          taxablePurchases: registered ? "2500000" : "0",
        },
        turnoverTax: { accountCode: "2110", ratePercent: registered ? null : "3.00", turnover: registered ? "0" : "100000", accrued: registered ? "0" : "3000", ledgerMovement: registered ? "0" : "3000", closingBalance: registered ? "0" : "3000", reconciles: true },
        anomalies: registered ? [] : [{ code: "VAT_OUTPUT_WHILE_NOT_REGISTERED", message: "Output VAT posted while the business is not VAT registered.", amount: "1192000" }],
      });
    }
    return null;
  };

  document.cookie = "ag_csrf=csrf-token; path=/";
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const call: Call = { method: init.method ?? "GET", url: new URL(input, "http://app.test"), body: typeof init.body === "string" ? JSON.parse(init.body) : undefined };
    server.calls.push(call);
    for (const route of server.routes) {
      const routed = route(call);
      if (routed) return routed;
    }
    return answer(call) ?? json(404, { statusCode: 404, error: "Not Found", message: "unrouted" });
  });
  return server;
}

export const queried = (server: TaxServer, path: string) => server.calls.filter((c) => c.method === "GET" && c.url.pathname === `/api/v1${path}`).map((c) => Object.fromEntries(c.url.searchParams));

export function showTax(role: Role = "MSME_OWNER") {
  return render(
    <ToastProvider>
      <DataProvider>
        <LocationProvider enabled={false}>
          <main>
            <Tax role={role} />
          </main>
        </LocationProvider>
      </DataProvider>
    </ToastProvider>,
  );
}
