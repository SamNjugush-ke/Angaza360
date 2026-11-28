"use client";

import { useState, type ReactNode } from "react";
import { amount, DocumentFrame, initialPeriod, PeriodPicker, periodLabel, periodQuery, type PeriodChoice } from "@/components/accounting/statements";
import { ErrorState, LoadingState } from "@/components/states/states";
import { businessToday } from "@/lib/datetime";
import { useVatReturn, type VatReturn } from "@/lib/tax/tax";
import { cn } from "@/lib/utils";

// The tax position for a period, laid out by the business's regime: a VAT-registered business gets
// its VAT return (output less input VAT, and turnover by KRA code), a Turnover Tax business its TOT
// position. Both are COMPUTED positions from the books — filing and paying are done on iTax, and
// nothing here records either. Anything in the books that does not fit the regime is shown, never
// hidden.

const POSITION: Readonly<Record<VatReturn["vat"]["position"], string>> = { PAYABLE: "Payable to KRA", REFUNDABLE: "Refundable by KRA", NIL: "Nil" };

function Row({ label, value, strong = false, indent = false }: { label: string; value: string; strong?: boolean; indent?: boolean }) {
  return (
    <tr className={cn(strong ? "border-t-4 border-double" : "border-b border-dashed")}>
      <th scope="row" className={cn("py-1.5 pr-3 text-left", strong ? "font-bold" : "font-normal", indent && "pl-4")}>
        {label}
      </th>
      <td className={cn("py-1.5 text-right tabular-nums", strong && "font-bold")}>{amount(value)}</td>
    </tr>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <tbody>
      <tr>
        <th scope="rowgroup" colSpan={2} className="pb-1 pt-4 text-left text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </th>
      </tr>
      {children}
    </tbody>
  );
}

function Anomalies({ data }: { data: VatReturn }) {
  if (data.anomalies.length === 0) return null;
  return (
    <section aria-labelledby="tax-anomalies" className="space-y-2 rounded-md border border-amber-600/40 bg-amber-500/10 p-3 text-sm">
      <h3 id="tax-anomalies" className="font-medium">
        For the accountant to look at
      </h3>
      <ul className="space-y-1">
        {data.anomalies.map((a) => (
          <li key={a.code}>
            {a.message} <span className="font-medium tabular-nums">KES {amount(a.amount)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function VatDoc({ data }: { data: VatReturn }) {
  const { vat } = data;
  return (
    <DocumentFrame title="VAT return" subtitle={`For the period ${periodLabel(data.period)} · VAT registered`} note="A computed position from the books. File and pay it on KRA iTax.">
      <table className="w-full text-sm">
        <caption className="sr-only">VAT return</caption>
        <Group title="Output VAT (on sales)">
          <Row label="VAT charged" value={vat.outputVat.charged} indent />
          <Row label="Reversed by voids" value={vat.outputVat.reversed} indent />
          <Row label="Net output VAT" value={vat.outputVat.net} />
        </Group>
        <Group title="Input VAT (on purchases)">
          <Row label="VAT claimed" value={vat.inputVat.claimed} indent />
          <Row label="Reversed" value={vat.inputVat.reversed} indent />
          <Row label="Net input VAT" value={vat.inputVat.net} />
        </Group>
        <tbody>
          <Row label={`Net VAT · ${POSITION[vat.position]}`} value={vat.netVat} strong />
        </tbody>
      </table>
      <table className="w-full text-sm">
        <caption className="pb-1 text-left font-semibold">Sales by KRA tax code</caption>
        <thead>
          <tr className="border-b-2">
            <th scope="col" className="py-1 text-left font-medium">Code</th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">Turnover</th>
            <th scope="col" className="py-1 text-right font-medium">VAT</th>
          </tr>
        </thead>
        <tbody>
          {(
            [
              ["B · Standard-rated", vat.salesByCode.standardRated.turnover, vat.salesByCode.standardRated.vat],
              ["C · Zero-rated", vat.salesByCode.zeroRated.turnover, null],
              ["A · Exempt", vat.salesByCode.exempt.turnover, null],
              ["D · Non-VAT", vat.salesByCode.nonVat.turnover, null],
            ] as const
          ).map(([label, turnover, tax]) => (
            <tr key={label} className="border-b border-dashed">
              <th scope="row" className="py-1 text-left font-normal">{label}</th>
              <td className="py-1 pr-3 text-right tabular-nums">{amount(turnover)}</td>
              <td className="py-1 text-right tabular-nums">{tax === null ? "—" : amount(tax)}</td>
            </tr>
          ))}
          <tr>
            <th scope="row" className="py-1 text-left font-normal">Taxable purchases</th>
            <td className="py-1 pr-3 text-right tabular-nums">{amount(vat.taxablePurchases)}</td>
            <td />
          </tr>
        </tbody>
      </table>
      <Anomalies data={data} />
    </DocumentFrame>
  );
}

function TotDoc({ data }: { data: VatReturn }) {
  const tot = data.turnoverTax;
  return (
    <DocumentFrame
      title="Turnover Tax position"
      subtitle={`For the period ${periodLabel(data.period)} · ${data.taxRegime === "TURNOVER_TAX" ? "on Turnover Tax" : "not VAT registered"}`}
      note="A computed position from the books: Turnover Tax is a tax on the business’s turnover, never charged to customers. File and pay it on KRA iTax."
    >
      <table className="w-full text-sm">
        <caption className="sr-only">Turnover Tax position</caption>
        <tbody>
          <tr className="border-b border-dashed">
            <th scope="row" className="py-1.5 text-left font-normal">Rate</th>
            <td className="py-1.5 text-right tabular-nums">{tot.ratePercent === null ? "—" : `${tot.ratePercent}%`}</td>
          </tr>
          <Row label="Turnover" value={tot.turnover} />
          <Row label="Turnover Tax accrued on sales" value={tot.accrued} />
          <Row label={`Moved through account ${tot.accountCode}`} value={tot.ledgerMovement} />
          <Row label="Owed to KRA at the period end" value={tot.closingBalance} strong />
        </tbody>
      </table>
      <p className="text-sm">
        <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", tot.reconciles ? "border-emerald-700/40 bg-emerald-700/10" : "border-destructive/40 bg-destructive/10")}>
          {tot.reconciles ? "Accrued equals the books" : "Accrued and the books differ"}
        </span>
      </p>
      <Anomalies data={data} />
    </DocumentFrame>
  );
}

export function VatReturnView() {
  const [today] = useState(() => businessToday());
  const [period, setPeriod] = useState<PeriodChoice>(() => initialPeriod(today));
  const chosen = periodQuery(period);
  const query = "query" in chosen ? { ...chosen.query, comparative: undefined } : null;
  const report = useVatReturn(query);
  return (
    <div className="space-y-4">
      <PeriodPicker value={period} onChange={setPeriod} withComparative={false} />
      <div aria-live="polite">
        {"problem" in chosen ? (
          <p role="alert" className="text-sm text-destructive">
            {chosen.problem}
          </p>
        ) : report.isPending ? (
          <LoadingState label="Preparing the tax position" lines={6} />
        ) : report.isError ? (
          <ErrorState title="Couldn’t prepare the tax position" description={report.error.message} onRetry={() => void report.refetch()} />
        ) : report.data.presentation === "VAT_RETURN" ? (
          <VatDoc data={report.data} />
        ) : (
          <TotDoc data={report.data} />
        )}
      </div>
    </div>
  );
}
