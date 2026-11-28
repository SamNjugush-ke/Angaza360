import { render } from "@testing-library/react";
import { vi } from "vitest";
import { Customers } from "@/components/customers/customers";
import { ExpensesPayables } from "@/components/expenses/expenses-payables";
import { DataProvider } from "@/components/providers/data-provider";
import { LocationProvider } from "@/components/shell/location";
import { ToastProvider } from "@/components/toast/toast";
import type { Role } from "@/lib/auth/landing";
import type { Customer } from "@/lib/receivables/receivables";

// A fake receivables server for the Customers & receivables tests: the directory, open credit sales,
// receipts allocated against them (refused when they over-allocate or do not add up — as the API
// does), statements with a running balance and the aging. A receipt lowers what is owed, so a later
// read shows the new balance. Requests are recorded, and any amount that is not a shilling string
// ("150.00") is refused.

export interface Call {
  method: string;
  url: URL;
  body: unknown;
}

export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const refusal = (status: number, message: string) => json(status, { statusCode: status, error: status === 409 ? "Conflict" : "Bad Request", message });

export function cents(amount: string): bigint {
  if (!/^\d+\.\d{2}$/.test(amount)) throw new Error(`not a shilling string: ${amount}`);
  return BigInt(amount.replace(".", ""));
}

export function customer(over: Partial<Customer> = {}): Customer {
  return {
    id: "c-1",
    name: "Kiptoo Construction Ltd",
    phone: "0712345678",
    email: null,
    kraPin: null,
    loyaltyPoints: 40,
    creditLimit: "10000000",
    creditBalance: "500000",
    isActive: true,
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z",
    ...over,
  };
}

interface Sale {
  saleId: string;
  saleNumber: string;
  customerId: string;
  saleDate: string;
  creditTotal: bigint;
  received: bigint;
  days: number;
}

export interface MoneyServer {
  calls: Call[];
  routes: Array<(call: Call) => Response | null>;
  customers: Customer[];
  outstanding: (saleId: string) => string;
}

export function installMoneyServer(): MoneyServer {
  const customers = [customer(), customer({ id: "c-2", name: "Wanjiru Builders", phone: "0722000000", creditLimit: "0", creditBalance: "0", loyaltyPoints: 3 })];
  const sales: Sale[] = [
    { saleId: "s-1", saleNumber: "SALE-20260901-000001", customerId: "c-1", saleDate: "2026-09-01T09:00:00.000Z", creditTotal: 200000n, received: 0n, days: 70 },
    { saleId: "s-2", saleNumber: "SALE-20261101-000004", customerId: "c-1", saleDate: "2026-11-01T09:00:00.000Z", creditTotal: 300000n, received: 0n, days: 9 },
  ];
  const receipts: Array<Record<string, unknown>> = [];
  const owed = (s: Sale) => s.creditTotal - s.received;
  const server: MoneyServer = { calls: [], routes: [], customers, outstanding: (id) => owed(sales.find((s) => s.saleId === id) as Sale).toString() };
  const nameOf = (id: string) => customers.find((c) => c.id === id)?.name ?? "";
  const open = (customerId?: string) =>
    sales
      .filter((s) => owed(s) > 0n && (!customerId || s.customerId === customerId))
      .map((s) => ({ saleId: s.saleId, saleNumber: s.saleNumber, customerId: s.customerId, customerName: nameOf(s.customerId), saleDate: s.saleDate, saleTotal: s.creditTotal.toString(), creditTotal: s.creditTotal.toString(), arReceived: s.received.toString(), outstanding: owed(s).toString(), daysOutstanding: s.days }));

  const answer = (call: Call): Response | null => {
    const path = call.url.pathname;
    const body = (call.body ?? {}) as Record<string, unknown>;
    if (path === "/api/v1/locations") return json(200, { data: [] });
    if (path === "/api/v1/customers" && call.method === "GET") return json(200, { data: customers });
    if (path === "/api/v1/customers" && call.method === "POST") {
      if (body.creditLimit !== undefined) cents(String(body.creditLimit));
      const created = customer({ id: `c-${(customers.length + 1).toString()}`, name: String(body.name), phone: (body.phone as string) ?? null, creditLimit: body.creditLimit ? cents(String(body.creditLimit)).toString() : "0", creditBalance: "0", loyaltyPoints: 0 });
      customers.push(created);
      return json(201, created);
    }
    const one = /^\/api\/v1\/customers\/([^/]+)$/.exec(path);
    if (one && call.method === "PATCH") {
      const found = customers.find((c) => c.id === one[1]);
      if (!found) return refusal(404, "No customer.");
      if (body.creditLimit !== undefined) found.creditLimit = cents(String(body.creditLimit)).toString();
      Object.assign(found, { name: body.name ?? found.name, phone: body.phone || null, isActive: body.isActive ?? found.isActive });
      return json(200, found);
    }
    if (path === "/api/v1/receivables/open") {
      const data = open(call.url.searchParams.get("customerId") ?? undefined);
      return json(200, { data, count: data.length, totalOutstanding: data.reduce((sum, s) => sum + BigInt(s.outstanding), 0n).toString() });
    }
    if (path === "/api/v1/receivables/receipts" && call.method === "POST") {
      const amount = cents(String(body.amount));
      const allocations = body.allocations as Array<{ saleId: string; amount: string }>;
      let sum = 0n;
      for (const a of allocations) {
        const s = sales.find((x) => x.saleId === a.saleId);
        const share = cents(a.amount);
        if (!s) return refusal(400, "Unknown sale.");
        if (share > owed(s)) return refusal(400, `Allocation of ${share.toString()} to ${s.saleNumber} exceeds its outstanding ${owed(s).toString()}.`);
        sum += share;
      }
      if (sum !== amount) return refusal(400, `Allocations total ${sum.toString()} but the receipt is ${amount.toString()}: every shilling must be allocated.`);
      for (const a of allocations) {
        const s = sales.find((x) => x.saleId === a.saleId) as Sale;
        s.received += cents(a.amount);
      }
      const c = customers.find((x) => x.id === body.customerId);
      if (c) c.creditBalance = (BigInt(c.creditBalance) - amount).toString();
      const receipt = {
        id: `r-${(receipts.length + 1).toString()}`,
        receiptNumber: receipts.length + 1,
        customerId: body.customerId,
        customerName: nameOf(String(body.customerId)),
        receiptDate: `${String(body.receiptDate)}T00:00:00.000Z`,
        method: body.method,
        amount: amount.toString(),
        reference: body.reference ?? null,
        notes: body.notes ?? null,
        createdById: "user-1",
        createdAt: "2026-11-10T08:00:00.000Z",
        allocations: allocations.map((a, i) => ({ id: `ra-${i.toString()}`, saleId: a.saleId, saleNumber: sales.find((s) => s.saleId === a.saleId)?.saleNumber ?? "", amount: cents(a.amount).toString() })),
      };
      receipts.unshift(receipt);
      return json(201, receipt);
    }
    if (path === "/api/v1/receivables/receipts") {
      const method = call.url.searchParams.get("method");
      const data = receipts.filter((r) => !method || r.method === method);
      return json(200, { data, count: data.length, totalReceived: data.reduce((sum, r) => sum + BigInt(String(r.amount)), 0n).toString() });
    }
    if (path === "/api/v1/receivables/aging") {
      const rows = customers
        .map((c) => {
          const mine = open(c.id);
          const bucket = (lo: number, hi: number) => mine.filter((s) => s.daysOutstanding >= lo && s.daysOutstanding <= hi).reduce((sum, s) => sum + BigInt(s.outstanding), 0n).toString();
          const total = mine.reduce((sum, s) => sum + BigInt(s.outstanding), 0n);
          return { customerId: c.id, customerName: c.name, current: bucket(0, 0), days1To30: bucket(1, 30), days31To60: bucket(31, 60), days61To90: bucket(61, 90), over90: bucket(91, 99999), total: total.toString(), saleCount: mine.length, oldestSaleDate: mine[0]?.saleDate ?? null, creditBalance: c.creditBalance, creditLimit: c.creditLimit };
        })
        .filter((r) => r.saleCount > 0);
      const sumOf = (key: "current" | "days1To30" | "days31To60" | "days61To90" | "over90") => rows.reduce((sum, r) => sum + BigInt(r[key]), 0n).toString();
      return json(200, {
        asOf: `${call.url.searchParams.get("asOf") ?? "2026-11-10"}T00:00:00.000Z`,
        customers: rows,
        totals: { current: sumOf("current"), days1To30: sumOf("days1To30"), days31To60: sumOf("days31To60"), days61To90: sumOf("days61To90"), over90: sumOf("over90") },
        grandTotal: rows.reduce((sum, r) => sum + BigInt(r.total), 0n).toString(),
      });
    }
    const statement = /^\/api\/v1\/receivables\/customers\/([^/]+)\/statement$/.exec(path);
    if (statement) {
      const id = statement[1] ?? "";
      let balance = 0n;
      const entries: Array<Record<string, string>> = [];
      for (const s of sales.filter((x) => x.customerId === id)) {
        balance += s.creditTotal;
        entries.push({ kind: "CREDIT_SALE", date: s.saleDate, reference: s.saleNumber, description: "Credit sale", charged: s.creditTotal.toString(), received: "0", runningBalance: balance.toString() });
      }
      for (const r of [...receipts].reverse().filter((x) => x.customerId === id)) {
        balance -= BigInt(String(r.amount));
        entries.push({ kind: "RECEIPT", date: String(r.receiptDate), reference: `Receipt ${String(r.receiptNumber)}`, description: String(r.method), charged: "0", received: String(r.amount), runningBalance: balance.toString() });
      }
      const c = customers.find((x) => x.id === id);
      return json(200, { customerId: id, customerName: c?.name ?? "", asOf: "2026-11-10T00:00:00.000Z", entries, totalCharged: "0", totalReceived: "0", closingBalance: balance.toString(), creditLimit: c?.creditLimit ?? "0" });
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

export const posted = (server: { calls: Call[] }, path: string, method = "POST") => server.calls.filter((c) => c.method === method && c.url.pathname === `/api/v1${path}`).map((c) => c.body);

export function showCustomers(role: Role = "MSME_OWNER") {
  return render(
    <ToastProvider>
      <DataProvider>
        <LocationProvider enabled={false}>
          <main>
            <Customers role={role} />
          </main>
        </LocationProvider>
      </DataProvider>
    </ToastProvider>,
  );
}

/**
 * Payables on the same fake server: the chart's accounts, suppliers, one RECEIVED purchase order
 * (PO 9: 4 + 6 nails at KES 140.00 — KES 1,400.00 accrued in GRNI), expenses with void, supplier bills
 * (DRAFT → posted → paid, cancel while unpaid) where posting a matched line clears what its goods
 * accrued and books the difference as price variance, payments allocated against bills (refused when
 * they over-allocate or do not add up), the AP aging by due date and supplier statements.
 */
export function installPayables(server: MoneyServer) {
  const accounts = [
    ["1000", "Cash on Hand", "ASSET"],
    ["1200", "Inventory", "ASSET"],
    ["1500", "Equipment", "ASSET"],
    ["5000", "Cost of Goods Sold", "COST_OF_SALES"],
    ["6000", "Rent", "EXPENSE"],
    ["6020", "Salaries & Wages", "EXPENSE"],
    ["6030", "Utilities", "EXPENSE"],
    ["6110", "Turnover Tax", "EXPENSE"],
    ["2000", "Accounts Payable", "LIABILITY"],
  ].map(([code, name, accountClass]) => ({ id: `a-${code ?? ""}`, code, name, accountClass, normalBalance: "DEBIT", isSystem: true, isActive: true, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" }));
  const suppliers = [
    { id: "sup-1", name: "Bamburi Distributors Ltd", contactName: null, phone: null, email: null, kraPin: null, paymentTerms: "Net 30", leadTimeDays: null, isActive: true, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" },
  ];
  const po = {
    id: "po-9",
    poNumber: 9,
    supplierId: "sup-1",
    supplierName: "Bamburi Distributors Ltd",
    status: "CLOSED",
    orderDate: "2026-11-05T00:00:00.000Z",
    expectedDate: null,
    currency: "KES",
    subtotal: "140000",
    notes: null,
    createdById: "u",
    approvedById: "u",
    approvedAt: "2026-11-05T00:00:00.000Z",
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
    lines: [{ id: "pol-1", productId: "p-nai", sku: "NKH-NAI-4", productName: "Wire Nails 4in", orderedQty: "10.000", unitCost: "14000", lineNet: "140000", receivedQty: "10.000", outstandingQty: "0.000", billedQty: "0.000", unbilledQty: "10.000" }],
  };
  const expenses: Array<Record<string, unknown>> = [];
  const bills: Array<Record<string, unknown> & { id: string; status: string; total: string; amountPaid: string; lines: Array<Record<string, unknown>> }> = [];
  const payments: Array<Record<string, unknown>> = [];
  const milli = (q: string) => {
    const [w = "0", f = ""] = q.split(".");
    return BigInt(w) * 1000n + BigInt(f.padEnd(3, "0").slice(0, 3));
  };
  const supplierName = (id: string) => suppliers.find((x) => x.id === id)?.name ?? "";

  function buildLines(raw: Array<Record<string, string>>, prefix: string) {
    return raw.map((l, i) => {
      const net = (cents(l.unitCost ?? "") * milli(l.quantity ?? "0")) / 1000n;
      return {
        id: `${prefix}-l${(i + 1).toString()}`,
        kind: l.purchaseOrderLineId ? "PO_MATCH" : "EXPENSE",
        description: l.description,
        quantity: l.quantity,
        vatRate: "0.00",
        lineNet: net.toString(),
        lineVat: "0",
        lineTotal: net.toString(),
        purchaseOrderLineId: l.purchaseOrderLineId ?? null,
        productId: l.purchaseOrderLineId ? "p-nai" : null,
        sku: l.purchaseOrderLineId ? "NKH-NAI-4" : null,
        unitCostNet: l.purchaseOrderLineId ? cents(l.unitCost ?? "").toString() : null,
        grniCleared: null as string | null,
        priceVariance: null as string | null,
        expenseAccountCode: l.expenseAccountCode ?? null,
      };
    });
  }
  const totalOf = (lines: Array<Record<string, unknown>>) => lines.reduce((sum, l) => sum + BigInt(String(l.lineNet)), 0n).toString();

  server.routes.push((call) => {
    const path = call.url.pathname;
    const body = (call.body ?? {}) as Record<string, unknown>;
    if (path === "/api/v1/accounts") return json(200, { data: accounts, count: accounts.length });
    if (path === "/api/v1/inventory/suppliers") return json(200, { data: suppliers });
    if (path === "/api/v1/procurement/purchase-orders") return json(200, { data: [po], count: 1 });
    if (path === "/api/v1/expenses" && call.method === "POST") {
      const e = {
        id: `e-${(expenses.length + 1).toString()}`,
        expenseDate: `${String(body.expenseDate)}T00:00:00.000Z`,
        category: body.category,
        payee: body.payee ?? null,
        description: body.description,
        paymentMethod: body.paymentMethod,
        amountCents: cents(String(body.amount)).toString(),
        vatInputCents: "0",
        reference: body.reference ?? null,
        journalEntryId: "je-e",
        isVoided: false,
        voidedByEntryId: null,
        voidedAt: null,
        voidReason: null,
        createdBy: "u",
        createdAt: "2026-11-10T08:00:00.000Z",
      };
      expenses.unshift(e);
      return json(201, e);
    }
    if (path === "/api/v1/expenses") return json(200, { data: expenses.filter((e) => call.url.searchParams.get("includeVoided") === "true" || !e.isVoided) });
    const voiding = /^\/api\/v1\/expenses\/([^/]+)\/void$/.exec(path);
    if (voiding) {
      const e = expenses.find((x) => x.id === voiding[1]);
      if (!e) return refusal(404, "No expense.");
      if (e.isVoided) return refusal(409, "This expense is already voided.");
      Object.assign(e, { isVoided: true, voidReason: body.reason, voidedAt: "2026-11-10T09:00:00.000Z", voidedByEntryId: "je-v" });
      return json(200, e);
    }
    if (path === "/api/v1/payables/bills" && call.method === "POST") {
      if (bills.some((b) => b.supplierId === body.supplierId && b.billNumber === body.billNumber)) return refusal(409, `Invoice ${String(body.billNumber)} from this supplier has already been entered.`);
      const id = `bill-${(bills.length + 1).toString()}`;
      const lines = buildLines(body.lines as Array<Record<string, string>>, id);
      const total = totalOf(lines);
      const bill = { id, billNumber: body.billNumber, supplierId: body.supplierId, supplierName: supplierName(String(body.supplierId)), poId: body.poId ?? null, poNumber: body.poId ? 9 : null, billDate: `${String(body.billDate)}T00:00:00.000Z`, dueDate: `${String(body.dueDate ?? body.billDate)}T00:00:00.000Z`, status: "DRAFT", subtotalNet: total, vatTotal: "0", total, amountPaid: "0", currency: "KES", notes: body.notes ?? null, createdById: "u", createdAt: "x", updatedAt: "x", lines };
      bills.unshift(bill);
      return json(201, bill);
    }
    if (path === "/api/v1/payables/bills") {
      const status = call.url.searchParams.get("status");
      const supplierId = call.url.searchParams.get("supplierId");
      const data = bills.filter((b) => (!status || b.status === status) && (!supplierId || b.supplierId === supplierId));
      return json(200, { data, count: data.length });
    }
    const one = /^\/api\/v1\/payables\/bills\/([^/]+)(?:\/(post|cancel))?$/.exec(path);
    if (one) {
      const bill = bills.find((b) => b.id === one[1]);
      if (!bill) return refusal(404, "No bill.");
      if (!one[2] && call.method === "GET") return json(200, bill);
      if (!one[2] && call.method === "PATCH") {
        if (bill.status !== "DRAFT") return refusal(409, "Only a DRAFT bill can be edited.");
        if (body.lines) {
          bill.lines = buildLines(body.lines as Array<Record<string, string>>, `${bill.id}-e`);
          Object.assign(bill, { subtotalNet: totalOf(bill.lines), total: totalOf(bill.lines) });
        }
        return json(200, bill);
      }
      if (one[2] === "post") {
        if (bill.status !== "DRAFT") return refusal(409, "Only a DRAFT bill can be posted.");
        for (const l of bill.lines) {
          if (l.kind !== "PO_MATCH") continue;
          const accrued = (14000n * milli(String(l.quantity))) / 1000n;
          l.grniCleared = accrued.toString();
          l.priceVariance = (BigInt(String(l.lineNet)) - accrued).toString();
        }
        bill.status = "AWAITING_PAYMENT";
        return json(200, bill);
      }
      if (one[2] === "cancel") {
        if (bill.status !== "AWAITING_PAYMENT") return refusal(409, "Only an unpaid posted bill can be cancelled.");
        bill.status = "CANCELLED";
        return json(200, bill);
      }
    }
    if (path === "/api/v1/payables/payments" && call.method === "POST") {
      const amount = cents(String(body.amount));
      const allocations = body.allocations as Array<{ billId: string; amount: string }>;
      let sum = 0n;
      for (const a of allocations) {
        const b = bills.find((x) => x.id === a.billId);
        if (!b) return refusal(400, "Unknown bill.");
        if (cents(a.amount) > BigInt(b.total) - BigInt(b.amountPaid)) return refusal(400, `Allocation to bill ${String(b.billNumber)} exceeds what is owed on it.`);
        sum += cents(a.amount);
      }
      if (sum !== amount) return refusal(400, "Allocations must sum to the payment exactly.");
      for (const a of allocations) {
        const b = bills.find((x) => x.id === a.billId) as (typeof bills)[number];
        b.amountPaid = (BigInt(b.amountPaid) + cents(a.amount)).toString();
        b.status = b.amountPaid === b.total ? "PAID" : "PARTIALLY_PAID";
      }
      const p = { id: `pay-${(payments.length + 1).toString()}`, paymentNumber: payments.length + 1, supplierId: body.supplierId, supplierName: supplierName(String(body.supplierId)), paymentDate: `${String(body.paymentDate)}T00:00:00.000Z`, method: body.method, amount: amount.toString(), reference: body.reference ?? null, notes: body.notes ?? null, createdById: "u", createdAt: "x", allocations: allocations.map((a, i) => ({ id: `pa-${i.toString()}`, billId: a.billId, billNumber: bills.find((b) => b.id === a.billId)?.billNumber ?? "", amount: cents(a.amount).toString() })) };
      payments.unshift(p);
      return json(201, p);
    }
    if (path === "/api/v1/payables/payments") return json(200, { data: payments, count: payments.length });
    if (path === "/api/v1/payables/aging") {
      const open = bills.filter((b) => b.status === "AWAITING_PAYMENT" || b.status === "PARTIALLY_PAID");
      const owed = (b: (typeof bills)[number]) => (BigInt(b.total) - BigInt(b.amountPaid)).toString();
      const rows = [...new Set(open.map((b) => String(b.supplierId)))].map((sid) => {
        const mine = open.filter((b) => b.supplierId === sid);
        const total = mine.reduce((sum, b) => sum + BigInt(owed(b)), 0n).toString();
        return { supplierId: sid, supplierName: supplierName(sid), current: total, days1To30: "0", days31To60: "0", days61To90: "0", over90: "0", total, billCount: mine.length, oldestDueDate: null };
      });
      const grand = rows.reduce((sum, r) => sum + BigInt(r.total), 0n).toString();
      return json(200, { asOf: "2026-11-10T00:00:00.000Z", suppliers: rows, totals: { current: grand, days1To30: "0", days31To60: "0", days61To90: "0", over90: "0" }, grandTotal: grand });
    }
    const st = /^\/api\/v1\/payables\/suppliers\/([^/]+)\/statement$/.exec(path);
    if (st) {
      let balance = 0n;
      const entries: Array<Record<string, unknown>> = [];
      for (const b of [...bills].reverse().filter((x) => x.supplierId === st[1] && x.status !== "DRAFT" && x.status !== "CANCELLED")) {
        balance += BigInt(b.total);
        entries.push({ kind: "BILL", date: b.billDate, reference: `Bill ${String(b.billNumber)}`, description: "Supplier invoice", charged: b.total, paid: "0", runningBalance: balance.toString(), billStatus: b.status, dueDate: b.dueDate });
      }
      for (const p of [...payments].reverse().filter((x) => x.supplierId === st[1])) {
        balance -= BigInt(String(p.amount));
        entries.push({ kind: "PAYMENT", date: p.paymentDate, reference: `Payment ${String(p.paymentNumber)}`, description: String(p.method), charged: "0", paid: p.amount, runningBalance: balance.toString(), billStatus: null, dueDate: null });
      }
      return json(200, { supplierId: st[1], supplierName: supplierName(st[1] ?? ""), asOf: "2026-11-10T00:00:00.000Z", entries, totalCharged: "0", totalPaid: "0", closingBalance: balance.toString() });
    }
    return null;
  });
  return { bills, expenses, po };
}

export function showExpenses(role: Role = "MSME_OWNER") {
  return render(
    <ToastProvider>
      <DataProvider>
        <LocationProvider enabled={false}>
          <main>
            <ExpensesPayables role={role} />
          </main>
        </LocationProvider>
      </DataProvider>
    </ToastProvider>,
  );
}
