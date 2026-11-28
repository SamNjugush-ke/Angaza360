import { render } from "@testing-library/react";
import { vi } from "vitest";
import { Accounting } from "@/components/accounting/accounting";
import { DataProvider } from "@/components/providers/data-provider";
import { LocationProvider } from "@/components/shell/location";
import { ToastProvider } from "@/components/toast/toast";
import type { Role } from "@/lib/auth/landing";
import { cents, json, refusal, type Call } from "./money";

// A fake ledger + reports server for the Accounting tests: the chart of accounts, journal entries
// (a manual entry is refused when it does not balance or falls in a closed month, exactly as the
// API does; a reversal posts the mirror of every line), each account's ledger with a running
// balance, the accounting periods (close / reopen), and the Module 13 statements — each recording
// the query it was asked. Any amount in a request that is not a shilling string is refused.

type Line = { accountCode: string; debit: bigint; credit: bigint; memo: string | null };
interface Entry {
  id: string;
  entryNumber: string;
  entryDate: string;
  description: string;
  reference: string | null;
  source: string;
  reversesEntryId: string | null;
  reversedByEntryId: string | null;
  lines: Line[];
}

export interface LedgerServer {
  calls: Call[];
  routes: Array<(call: Call) => Response | null>;
  entries: Entry[];
  periods: Array<{ id: string; year: number; month: number; status: "OPEN" | "CLOSED"; closedAt: string | null; closedBy: string | null; createdAt: string }>;
}

const ACCOUNTS: ReadonlyArray<[string, string, string, string, boolean?]> = [
  ["1000", "Cash on Hand", "ASSET", "DEBIT"],
  ["1010", "M-Pesa Till", "ASSET", "DEBIT"],
  ["1100", "Accounts Receivable", "ASSET", "DEBIT"],
  ["1200", "Inventory", "ASSET", "DEBIT"],
  ["2000", "Accounts Payable", "LIABILITY", "CREDIT"],
  ["2050", "Goods Received Not Invoiced", "LIABILITY", "CREDIT"],
  ["3000", "Owner's Capital", "EQUITY", "CREDIT"],
  ["4000", "Sales Revenue", "REVENUE", "CREDIT"],
  ["5000", "Cost of Goods Sold", "COST_OF_SALES", "DEBIT"],
  ["6000", "Rent", "EXPENSE", "DEBIT"],
  ["6030", "Utilities", "EXPENSE", "DEBIT"],
  ["6999", "Old Sundry Account", "EXPENSE", "DEBIT", false],
];

const line = (code: string | null, name: string, amount: string, comparativeAmount: string | null) => ({ code, name, amount, comparativeAmount });
const section = (lines: ReturnType<typeof line>[], total: string, comparativeTotal: string | null) => ({ lines, total, comparativeTotal });
const figure = (amount: string, comparativeAmount: string | null) => ({ amount, comparativeAmount });

export function installLedgerServer(): LedgerServer {
  const accounts = ACCOUNTS.map(([code, name, accountClass, normalBalance, active]) => ({ id: `a-${code}`, code, name, accountClass, normalBalance, isSystem: true, isActive: active ?? true, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" }));
  const entries: Entry[] = [
    { id: "je-1", entryNumber: "JE-000001", entryDate: "2026-10-03T00:00:00.000Z", description: "Opening capital", reference: null, source: "OPENING_BALANCE", reversesEntryId: null, reversedByEntryId: null, lines: [{ accountCode: "1000", debit: 5000000n, credit: 0n, memo: null }, { accountCode: "3000", debit: 0n, credit: 5000000n, memo: null }] },
    { id: "je-2", entryNumber: "JE-000002", entryDate: "2026-11-02T00:00:00.000Z", description: "Sale SALE-20261102-000001", reference: null, source: "POS", reversesEntryId: null, reversedByEntryId: null, lines: [{ accountCode: "1000", debit: 116000n, credit: 0n, memo: null }, { accountCode: "4000", debit: 0n, credit: 116000n, memo: null }] },
  ];
  const server: LedgerServer = {
    calls: [],
    routes: [],
    entries,
    periods: [
      { id: "p-10", year: 2026, month: 10, status: "CLOSED", closedAt: "2026-11-01T06:00:00.000Z", closedBy: "user-1", createdAt: "2026-10-01T00:00:00.000Z" },
      { id: "p-11", year: 2026, month: 11, status: "OPEN", closedAt: null, closedBy: null, createdAt: "2026-11-01T00:00:00.000Z" },
    ],
  };
  const account = (code: string) => accounts.find((a) => a.code === code);
  const detail = (e: Entry) => {
    const [y = "2026", m = "1"] = e.entryDate.split("-");
    return {
      id: e.id,
      entryNumber: e.entryNumber,
      entryDate: e.entryDate,
      periodYear: Number(y),
      periodMonth: Number(m),
      description: e.description,
      reference: e.reference,
      source: e.source,
      sourceId: null,
      status: e.reversedByEntryId ? "REVERSED" : "POSTED",
      reversesEntryId: e.reversesEntryId,
      reversedByEntryId: e.reversedByEntryId,
      createdBy: "user-1",
      postedAt: e.entryDate,
      lines: e.lines.map((l, i) => {
        const a = account(l.accountCode);
        return { id: `${e.id}-l${i.toString()}`, entryId: e.id, lineNumber: i + 1, accountId: a?.id ?? "", debit: l.debit.toString(), credit: l.credit.toString(), memo: l.memo, account: { code: l.accountCode, name: a?.name ?? "", accountClass: a?.accountClass ?? "ASSET" } };
      }),
    };
  };
  const nextNumber = () => `JE-${(entries.length + 1).toString().padStart(6, "0")}`;
  const closed = (date: string) => {
    const [y = "0", m = "0"] = date.split("-");
    return server.periods.some((p) => p.year === Number(y) && p.month === Number(m) && p.status === "CLOSED");
  };

  const answer = (call: Call): Response | null => {
    const path = call.url.pathname;
    const q = call.url.searchParams;
    const body = (call.body ?? {}) as Record<string, unknown>;
    if (path === "/api/v1/locations") return json(200, { data: [] });
    if (path === "/api/v1/accounts") return json(200, { data: accounts });
    if (path === "/api/v1/ledger/entries" && call.method === "GET") {
      const from = q.get("from");
      const to = q.get("to");
      const shown = [...entries].reverse().filter((e) => (!from || e.entryDate.slice(0, 10) >= from) && (!to || e.entryDate.slice(0, 10) <= to));
      const skip = Number(q.get("skip") ?? "0");
      const take = Number(q.get("take") ?? "25");
      return json(200, { data: shown.slice(skip, skip + take).map(detail), pagination: { total: shown.length, skip, take } });
    }
    if (path === "/api/v1/ledger/entries" && call.method === "POST") {
      const raw = body.lines as Array<{ accountCode: string; debit?: string; credit?: string; memo?: string }>;
      const lines = raw.map((l) => ({ accountCode: l.accountCode, debit: l.debit === undefined ? 0n : cents(l.debit), credit: l.credit === undefined ? 0n : cents(l.credit), memo: l.memo ?? null }));
      const dr = lines.reduce((s, l) => s + l.debit, 0n);
      const cr = lines.reduce((s, l) => s + l.credit, 0n);
      if (dr !== cr) return refusal(400, `Journal entry is unbalanced: debits ${dr.toString()} ≠ credits ${cr.toString()}.`);
      const date = String(body.entryDate);
      if (closed(date)) return refusal(409, `Accounting period ${date.slice(0, 7)} is closed.`);
      const created: Entry = { id: `je-${(entries.length + 1).toString()}`, entryNumber: nextNumber(), entryDate: `${date}T00:00:00.000Z`, description: String(body.description), reference: (body.reference as string | undefined) ?? null, source: String(body.source), reversesEntryId: null, reversedByEntryId: null, lines };
      entries.push(created);
      return json(201, detail(created));
    }
    const reverse = /^\/api\/v1\/ledger\/entries\/([^/]+)\/reverse$/.exec(path);
    if (reverse && call.method === "POST") {
      const original = entries.find((e) => e.id === reverse[1]);
      if (!original) return refusal(404, "No such entry.");
      if (original.reversedByEntryId) return refusal(409, "Entry is already reversed.");
      const mirror: Entry = {
        id: `je-${(entries.length + 1).toString()}`,
        entryNumber: nextNumber(),
        entryDate: "2026-11-10T00:00:00.000Z",
        description: `Reversal of ${original.entryNumber}: ${String(body.reason)}`,
        reference: null,
        source: original.source,
        reversesEntryId: original.id,
        reversedByEntryId: null,
        lines: original.lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })),
      };
      entries.push(mirror);
      original.reversedByEntryId = mirror.id;
      return json(201, detail(mirror));
    }
    const one = /^\/api\/v1\/ledger\/entries\/([^/]+)$/.exec(path);
    if (one) {
      const found = entries.find((e) => e.id === one[1]);
      return found ? json(200, detail(found)) : refusal(404, "No such entry.");
    }
    const ledger = /^\/api\/v1\/ledger\/accounts\/([^/]+)\/ledger$/.exec(path);
    if (ledger) {
      const a = account(ledger[1] ?? "");
      if (!a) return refusal(404, "No such account.");
      const debitNormal = a.normalBalance === "DEBIT";
      let balance = 0n;
      const rows = entries.flatMap((e) =>
        e.lines
          .map((l, i) => ({ l, i }))
          .filter(({ l }) => l.accountCode === a.code)
          .map(({ l, i }) => {
            balance += debitNormal ? l.debit - l.credit : l.credit - l.debit;
            return { entryId: e.id, entryNumber: e.entryNumber, entryDate: e.entryDate, lineNumber: i + 1, description: e.description, source: e.source, status: e.reversedByEntryId ? "REVERSED" : "POSTED", debit: l.debit.toString(), credit: l.credit.toString(), runningBalance: balance.toString() };
          }),
      );
      const skip = Number(q.get("skip") ?? "0");
      const take = Number(q.get("take") ?? "50");
      return json(200, { account: { code: a.code, name: a.name, accountClass: a.accountClass, normalBalance: a.normalBalance }, openingBalance: "0", closingBalance: balance.toString(), rows: rows.slice(skip, skip + take), pagination: { total: rows.length, skip, take } });
    }
    if (path === "/api/v1/ledger/periods") return json(200, { data: server.periods });
    const period = /^\/api\/v1\/ledger\/periods\/(\d+)\/(\d+)\/(close|reopen)$/.exec(path);
    if (period && call.method === "POST") {
      const found = server.periods.find((p) => p.year === Number(period[1]) && p.month === Number(period[2]));
      if (!found) return refusal(404, "No such period.");
      if (period[3] === "close") Object.assign(found, { status: "CLOSED", closedAt: "2026-11-10T09:00:00.000Z", closedBy: "user-1" });
      else Object.assign(found, { status: "OPEN", closedAt: null, closedBy: null });
      return json(200, found);
    }
    const compare = q.get("comparative") !== "false";
    if (path === "/api/v1/reports/income-statement") {
      return json(200, {
        period: { from: "2026-11-01T00:00:00.000Z", to: "2026-11-10T00:00:00.000Z" },
        comparativePeriod: compare ? { from: "2026-10-01T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z" } : null,
        revenue: section([line("4000", "Sales Revenue", "9145000", compare ? "720000" : null), line("4900", "Sales Returns", "-25000", compare ? "0" : null)], "9120000", compare ? "720000" : null),
        costOfSales: section([line("5000", "Cost of Goods Sold", "2800000", compare ? "300000" : null)], "2800000", compare ? "300000" : null),
        grossProfit: figure("6320000", compare ? "420000" : null),
        operatingExpenses: section([line("6000", "Rent", "1500000", compare ? "1500000" : null)], "1500000", compare ? "1500000" : null),
        netProfit: figure("4820000", compare ? "-1080000" : null),
      });
    }
    if (path === "/api/v1/reports/balance-sheet") {
      return json(200, {
        asOf: `${q.get("asOf") ?? "2026-11-10"}T00:00:00.000Z`,
        comparativeAsOf: compare ? "2026-10-31T00:00:00.000Z" : null,
        financialYearStart: "2026-01-01T00:00:00.000Z",
        assets: {
          current: section([line("1000", "Cash on Hand", "5116000", compare ? "5000000" : null)], "5116000", compare ? "5000000" : null),
          nonCurrent: section([], "0", compare ? "0" : null),
          total: figure("5116000", compare ? "5000000" : null),
        },
        liabilities: { current: section([], "0", compare ? "0" : null), longTerm: section([], "0", compare ? "0" : null), total: figure("0", compare ? "0" : null) },
        equity: section([line("3000", "Owner's Capital", "5000000", compare ? "5000000" : null), line(null, "Current-year earnings", "116000", compare ? "0" : null)], "5116000", compare ? "5000000" : null),
        liabilitiesAndEquity: figure("5116000", compare ? "5000000" : null),
        balances: true,
      });
    }
    if (path === "/api/v1/reports/cash-flow") {
      return json(200, {
        period: { from: "2026-11-01T00:00:00.000Z", to: "2026-11-10T00:00:00.000Z" },
        comparativePeriod: null,
        netProfit: figure("116000", null),
        nonCashAdjustments: section([], "0", null),
        workingCapitalChanges: section([], "0", null),
        operatingActivities: figure("116000", null),
        investingActivities: section([], "0", null),
        financingActivities: section([], "0", null),
        netChangeInCash: figure("116000", null),
        openingCash: figure("5000000", null),
        closingCash: figure("5116000", null),
        tiesOut: true,
      });
    }
    if (path === "/api/v1/reports/trial-balance") {
      return json(200, {
        asOf: `${q.get("asOf") ?? "2026-11-10"}T00:00:00.000Z`,
        comparativeAsOf: compare ? "2026-10-31T00:00:00.000Z" : null,
        rows: [
          { code: "1000", name: "Cash on Hand", accountClass: "ASSET", section: "Current assets", debit: "5116000", credit: "0", comparativeDebit: compare ? "5000000" : null, comparativeCredit: compare ? "0" : null },
          { code: "3000", name: "Owner's Capital", accountClass: "EQUITY", section: "Equity", debit: "0", credit: "5000000", comparativeDebit: compare ? "0" : null, comparativeCredit: compare ? "5000000" : null },
          { code: "4000", name: "Sales Revenue", accountClass: "REVENUE", section: "Revenue", debit: "0", credit: "116000", comparativeDebit: compare ? "0" : null, comparativeCredit: compare ? "0" : null },
        ],
        totals: { debit: "5116000", credit: "5116000", comparativeDebit: compare ? "5000000" : null, comparativeCredit: compare ? "5000000" : null },
        balanced: true,
      });
    }
    if (path === "/api/v1/reports/control-reconciliation") {
      return json(200, {
        basis: "CURRENT",
        items: [
          { control: "INVENTORY", accountCode: "1200", glBalance: "29224995", subledgerLabel: "Σ product carrying value", subledger: "29224995", residuals: [], unexplained: "0", reconciles: true },
          { control: "ACCOUNTS_RECEIVABLE", accountCode: "1100", glBalance: "5469600", subledgerLabel: "Open credit sales", subledger: "5434800", residuals: [{ label: "M-Pesa payments that failed after the sale", amount: "34800" }], unexplained: "0", reconciles: true },
        ],
        allReconcile: true,
      });
    }
    if (path === "/api/v1/reports/top-products") {
      return json(200, [
        { productId: "p-1", sku: "CEM-50", name: "Cement 50kg", kind: "GOOD", quantity: "12.000", revenue: "960000" },
        { productId: "p-2", sku: "DEL-1", name: "Delivery", kind: "SERVICE", quantity: "3.000", revenue: "150000" },
      ]);
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

export const asked = (server: LedgerServer, path: string) => server.calls.filter((c) => c.method === "GET" && c.url.pathname === `/api/v1${path}`).map((c) => Object.fromEntries(c.url.searchParams));

export function showAccounting(role: Role = "MSME_OWNER") {
  return render(
    <ToastProvider>
      <DataProvider>
        <LocationProvider enabled={false}>
          <main>
            <Accounting role={role} />
          </main>
        </LocationProvider>
      </DataProvider>
    </ToastProvider>,
  );
}
