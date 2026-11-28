"use client";

import { useId, useState } from "react";
import { SelectField } from "@/components/stock/kit";
import {
  fetchBalanceSheet,
  fetchCashFlow,
  fetchControls,
  fetchIncomeStatement,
  fetchTopProducts,
  fetchTrialBalance,
  periodName,
  useReport,
  type BalanceSheet,
  type CashFlow,
  type ControlReconciliation,
  type IncomeStatement,
  type TopProducts,
  type TrialBalance,
} from "@/lib/accounting/accounting";
import { businessToday, formatDate } from "@/lib/datetime";
import { formatKES } from "@/lib/money";
import { displayQuantity } from "@/lib/pos/quantity";
import { cn } from "@/lib/utils";
import { amount, AsOfPicker, DocumentFrame, FigureRows, initialPeriod, PeriodPicker, periodLabel, periodQuery, ReportState, SectionRows, StatementTable, TotalRow, type Columns, type PeriodChoice } from "./statements";

// The financial statements, each laid out as the document an owner or accountant files and prints:
// sectioned, figures aligned, totals ruled, the comparative period beside the current one. The
// figures are the server's (Module 13) — a statement that failed its own identity never arrives.

type ReportName = "income" | "balance" | "cash" | "trial" | "controls" | "top";
const REPORTS: ReadonlyArray<[ReportName, string]> = [
  ["income", "Income statement"],
  ["balance", "Balance sheet"],
  ["cash", "Cash flow statement"],
  ["trial", "Trial balance"],
  ["controls", "Control-account reconciliation"],
  ["top", "Top-selling products"],
];

function IncomeDoc({ data }: { data: IncomeStatement }) {
  const columns: Columns = { current: periodLabel(data.period), comparative: data.comparativePeriod ? periodLabel(data.comparativePeriod) : null };
  return (
    <DocumentFrame title="Income statement" subtitle={`For the period ${periodLabel(data.period)}`}>
      <StatementTable caption="Income statement" columns={columns}>
        <SectionRows title="Revenue" section={data.revenue} columns={columns} totalLabel="Total revenue" />
        <SectionRows title="Cost of sales" section={data.costOfSales} columns={columns} totalLabel="Total cost of sales" />
        <FigureRows label="Gross profit" figure={data.grossProfit} columns={columns} strong={false} />
        <SectionRows title="Operating expenses" section={data.operatingExpenses} columns={columns} totalLabel="Total operating expenses" />
        <FigureRows label="Net profit" figure={data.netProfit} columns={columns} />
      </StatementTable>
    </DocumentFrame>
  );
}

function BalanceDoc({ data }: { data: BalanceSheet }) {
  const columns: Columns = { current: formatDate(data.asOf), comparative: data.comparativeAsOf ? formatDate(data.comparativeAsOf) : null };
  return (
    <DocumentFrame title="Balance sheet" subtitle={`As at ${formatDate(data.asOf)}`} note="Equity includes the earnings of the current financial year, which starts on the date shown.">
      <StatementTable caption="Balance sheet" columns={columns}>
        <SectionRows title="Current assets" section={data.assets.current} columns={columns} totalLabel="Total current assets" />
        <SectionRows title="Non-current assets" section={data.assets.nonCurrent} columns={columns} totalLabel="Total non-current assets" />
        <FigureRows label="Total assets" figure={data.assets.total} columns={columns} />
        <SectionRows title="Current liabilities" section={data.liabilities.current} columns={columns} totalLabel="Total current liabilities" />
        <SectionRows title="Long-term liabilities" section={data.liabilities.longTerm} columns={columns} totalLabel="Total long-term liabilities" />
        <FigureRows label="Total liabilities" figure={data.liabilities.total} columns={columns} strong={false} />
        <SectionRows title="Equity" section={data.equity} columns={columns} totalLabel="Total equity" />
        <FigureRows label="Total liabilities and equity" figure={data.liabilitiesAndEquity} columns={columns} />
      </StatementTable>
      <p className="text-xs text-muted-foreground">Financial year from {formatDate(data.financialYearStart)}. Assets equal liabilities plus equity.</p>
    </DocumentFrame>
  );
}

function CashDoc({ data }: { data: CashFlow }) {
  const columns: Columns = { current: periodLabel(data.period), comparative: data.comparativePeriod ? periodLabel(data.comparativePeriod) : null };
  return (
    <DocumentFrame title="Cash flow statement" subtitle={`For the period ${periodLabel(data.period)} · indirect method`}>
      <StatementTable caption="Cash flow statement" columns={columns}>
        <FigureRows label="Net profit" figure={data.netProfit} columns={columns} strong={false} />
        <SectionRows title="Non-cash adjustments" section={data.nonCashAdjustments} columns={columns} totalLabel="Total non-cash adjustments" />
        <SectionRows title="Changes in working capital" section={data.workingCapitalChanges} columns={columns} totalLabel="Total working-capital changes" />
        <FigureRows label="Net cash from operating activities" figure={data.operatingActivities} columns={columns} />
        <SectionRows title="Investing activities" section={data.investingActivities} columns={columns} totalLabel="Net cash from investing activities" />
        <SectionRows title="Financing activities" section={data.financingActivities} columns={columns} totalLabel="Net cash from financing activities" />
        <FigureRows label="Net change in cash" figure={data.netChangeInCash} columns={columns} />
        <FigureRows label="Cash at the start" figure={data.openingCash} columns={columns} strong={false} />
        <FigureRows label="Cash at the end" figure={data.closingCash} columns={columns} />
      </StatementTable>
    </DocumentFrame>
  );
}

function TrialDoc({ data }: { data: TrialBalance }) {
  const compare = data.comparativeAsOf !== null;
  return (
    <DocumentFrame title="Trial balance" subtitle={`As at ${formatDate(data.asOf)}`} note="Every account on the side its balance falls; the two columns are equal.">
      <div className="overflow-x-auto" role="region" aria-label="Trial balance, scrollable" tabIndex={0}>
        <table className="w-full min-w-[30rem] text-sm">
          <caption className="sr-only">Trial balance</caption>
          <thead>
            <tr className="border-b-2">
              <th scope="col" className="py-1 text-left font-medium">Account</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">Debit</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">Credit</th>
              {compare ? <th scope="col" className="py-1 pr-3 text-right font-medium text-muted-foreground">Debit {formatDate(data.comparativeAsOf ?? "")}</th> : null}
              {compare ? <th scope="col" className="py-1 text-right font-medium text-muted-foreground">Credit {formatDate(data.comparativeAsOf ?? "")}</th> : null}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.code} className="border-b border-dashed last:border-b-0">
                <th scope="row" className="py-1 pr-3 text-left font-normal">
                  <span className="mr-2 font-mono text-xs text-muted-foreground">{row.code}</span>
                  {row.name}
                </th>
                <td className="py-1 pr-3 text-right tabular-nums">{row.debit === "0" ? "" : formatKES(row.debit)}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{row.credit === "0" ? "" : formatKES(row.credit)}</td>
                {compare ? <td className="py-1 pr-3 text-right tabular-nums text-muted-foreground">{row.comparativeDebit && row.comparativeDebit !== "0" ? formatKES(row.comparativeDebit) : ""}</td> : null}
                {compare ? <td className="py-1 text-right tabular-nums text-muted-foreground">{row.comparativeCredit && row.comparativeCredit !== "0" ? formatKES(row.comparativeCredit) : ""}</td> : null}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-4 border-double font-bold">
              <th scope="row" className="py-1.5 text-left">Totals</th>
              <td className="py-1.5 pr-3 text-right tabular-nums">{formatKES(data.totals.debit)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{formatKES(data.totals.credit)}</td>
              {compare ? <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">{amount(data.totals.comparativeDebit)}</td> : null}
              {compare ? <td className="py-1.5 text-right tabular-nums text-muted-foreground">{amount(data.totals.comparativeCredit)}</td> : null}
            </tr>
          </tfoot>
        </table>
      </div>
    </DocumentFrame>
  );
}

const CONTROL_LABEL: Readonly<Record<ControlReconciliation["items"][number]["control"], string>> = {
  INVENTORY: "Inventory",
  ACCOUNTS_RECEIVABLE: "Accounts receivable",
  ACCOUNTS_PAYABLE: "Accounts payable",
  GRNI: "Goods received not invoiced",
};

function ControlsDoc({ data }: { data: ControlReconciliation }) {
  return (
    <DocumentFrame title="Control-account reconciliation" subtitle={`As it stands now · ${data.allReconcile ? "every control reconciles" : "a control does not reconcile"}`} note="Each subledger tied to its control account in the books, with the known structural differences shown as named lines. Unexplained must be nil.">
      <div className="space-y-4">
        {data.items.map((item) => (
          <table key={item.control} className="w-full text-sm">
            <caption className="pb-1 text-left font-semibold">
              {CONTROL_LABEL[item.control]} · account {item.accountCode}{" "}
              <span className={cn("ml-2 rounded-full border px-2 py-0.5 text-xs font-medium", item.reconciles ? "border-emerald-700/40 bg-emerald-700/10" : "border-destructive/40 bg-destructive/10")}>
                {item.reconciles ? "Reconciles" : "Does not reconcile"}
              </span>
            </caption>
            <tbody>
              <tr className="border-b border-dashed">
                <th scope="row" className="py-1 pl-4 text-left font-normal">Balance in the books</th>
                <td className="py-1 text-right tabular-nums">{amount(item.glBalance)}</td>
              </tr>
              <tr className="border-b border-dashed">
                <th scope="row" className="py-1 pl-4 text-left font-normal">{item.subledgerLabel}</th>
                <td className="py-1 text-right tabular-nums">{amount(item.subledger)}</td>
              </tr>
              {item.residuals.map((r) => (
                <tr key={r.label} className="border-b border-dashed">
                  <th scope="row" className="py-1 pl-4 text-left font-normal">{r.label}</th>
                  <td className="py-1 text-right tabular-nums">{amount(r.amount)}</td>
                </tr>
              ))}
              <TotalRow label="Unexplained" value={item.unexplained} />
            </tbody>
          </table>
        ))}
      </div>
    </DocumentFrame>
  );
}

function TopDoc({ data, by, subtitle }: { data: TopProducts; by: "revenue" | "quantity"; subtitle: string }) {
  return (
    <DocumentFrame title="Top-selling products" subtitle={`${subtitle} · ranked by ${by === "revenue" ? "net revenue" : "quantity"}`} note="Net of voids and discounts, before VAT — the same basis as the income statement's revenue.">
      {data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No sales in this period.</p>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">Top-selling products</caption>
          <thead>
            <tr className="border-b-2">
              <th scope="col" className="py-1 text-left font-medium">#</th>
              <th scope="col" className="py-1 text-left font-medium">Product</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">Quantity</th>
              <th scope="col" className="py-1 text-right font-medium">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {data.map((p, i) => (
              <tr key={p.productId} className="border-b border-dashed last:border-b-0">
                <td className="py-1">{(i + 1).toString()}</td>
                <th scope="row" className="py-1 text-left font-normal">
                  {p.name} <span className="font-mono text-xs text-muted-foreground">{p.sku}</span>
                </th>
                <td className="py-1 pr-3 text-right tabular-nums">{displayQuantity(p.quantity)}</td>
                <td className="py-1 text-right tabular-nums">{formatKES(p.revenue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </DocumentFrame>
  );
}

export function ReportsView() {
  const ids = { report: useId(), by: useId() };
  const [today] = useState(() => businessToday());
  const [name, setName] = useState<ReportName>("income");
  const [period, setPeriod] = useState<PeriodChoice>(() => initialPeriod(today));
  const [asOf, setAsOf] = useState(today);
  const [asOfCompare, setAsOfCompare] = useState(true);
  const [by, setBy] = useState<"revenue" | "quantity">("revenue");
  const periodic = name === "income" || name === "cash" || name === "top";
  const asAt = name === "balance" || name === "trial";
  const chosen = periodQuery(period);
  const periodProblem = "problem" in chosen ? chosen.problem : null;
  const query = "query" in chosen ? chosen.query : null;
  const asOfProblem = /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? (asOf > today ? "Choose a date that is not in the future." : null) : "Choose a date.";
  const asOfQuery = asOfProblem ? null : { asOf, comparative: asOfCompare ? undefined : "false" };
  const topQuery = query ? { ...query, comparative: undefined, by, limit: "20" } : null;

  const income = useReport("income", fetchIncomeStatement, name === "income" ? query : null);
  const cash = useReport("cash", fetchCashFlow, name === "cash" ? query : null);
  const balance = useReport("balance", fetchBalanceSheet, name === "balance" ? asOfQuery : null);
  const trial = useReport("trial", fetchTrialBalance, name === "trial" ? asOfQuery : null);
  const top = useReport("top", fetchTopProducts, name === "top" ? topQuery : null);
  const controls = useReport("controls", () => fetchControls(), name === "controls" ? {} : null);
  const topSubtitle =
    period.mode === "custom" ? (periodProblem ? "" : `${formatDate(period.from)} – ${formatDate(period.to)}`) : period.mode === "mtd" ? "This month to date" : period.mode === "year" ? `The year ${period.year}` : periodName(Number.parseInt(period.year, 10), Number.parseInt(period.month, 10));

  return (
    <div className="space-y-4">
      <div className="no-print grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SelectField id={ids.report} label="Report" value={name} onChange={(v) => setName(v as ReportName)}>
          {REPORTS.map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </SelectField>
        {name === "top" ? (
          <SelectField id={ids.by} label="Rank by" value={by} onChange={(v) => setBy(v as "revenue" | "quantity")}>
            <option value="revenue">Net revenue</option>
            <option value="quantity">Quantity</option>
          </SelectField>
        ) : null}
      </div>
      {periodic ? <PeriodPicker value={period} onChange={setPeriod} withComparative={name !== "top"} /> : null}
      {asAt ? <AsOfPicker value={asOf} onChange={setAsOf} comparative={asOfCompare} onComparative={setAsOfCompare} /> : null}
      {name === "controls" ? <p className="no-print text-sm text-muted-foreground">The reconciliation is always as things stand now: the subledgers keep no history to date back.</p> : null}

      <div aria-live="polite">
        {name === "income" ? <ReportState label="income statement" problem={periodProblem} report={income} render={(d) => <IncomeDoc data={d} />} /> : null}
        {name === "cash" ? <ReportState label="cash flow statement" problem={periodProblem} report={cash} render={(d) => <CashDoc data={d} />} /> : null}
        {name === "balance" ? <ReportState label="balance sheet" problem={asOfProblem} report={balance} render={(d) => <BalanceDoc data={d} />} /> : null}
        {name === "trial" ? <ReportState label="trial balance" problem={asOfProblem} report={trial} render={(d) => <TrialDoc data={d} />} /> : null}
        {name === "controls" ? <ReportState label="reconciliation" problem={null} report={controls} render={(d) => <ControlsDoc data={d} />} /> : null}
        {name === "top" ? <ReportState label="top products" problem={periodProblem} report={top} render={(d) => <TopDoc data={d} by={by} subtitle={topSubtitle} />} /> : null}
      </div>
    </div>
  );
}
