"use client";

import { Printer } from "lucide-react";
import { Fragment, useId, useState, type ReactNode } from "react";
import { TextField } from "@/components/auth/form-bits";
import { SelectField } from "@/components/stock/kit";
import { ErrorState, LoadingState } from "@/components/states/states";
import { Button } from "@/components/ui/button";
import { MONTHS, type Figure, type ReportQuery, type Section } from "@/lib/accounting/accounting";
import { businessToday, formatDate } from "@/lib/datetime";
import { formatKES, parseCents } from "@/lib/money";
import { cn } from "@/lib/utils";

// The pieces every financial statement shares: the document frame (title, period, print), a
// statement table with real table semantics — sections as row groups, lines as row headers, the
// period and its comparative as columns, negatives in brackets as on a printed statement — and the
// period / as-at picker. Every figure is the server's; this only lays it out.

/** A statement figure: brackets for a negative, as accountants print them. */
export function amount(cents: string | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  const value = parseCents(cents);
  return value < 0n ? `(${formatKES(-value)})` : formatKES(value);
}

export function DocumentFrame({ title, subtitle, note, children, actions }: { title: string; subtitle: string; note?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  const heading = useId();
  return (
    <section className="print-area print-document space-y-4 rounded-lg border bg-background p-4 sm:p-6" aria-labelledby={heading}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b pb-3">
        <div>
          <h2 id={heading} className="font-display text-xl font-semibold">
            {title}
          </h2>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
          <p className="text-xs text-muted-foreground">Amounts in Kenya shillings.</p>
        </div>
        <div className="no-print flex flex-wrap gap-2">
          {actions}
          <Button type="button" variant="outline" className="h-11" onClick={() => window.print()}>
            <Printer aria-hidden /> Print
          </Button>
        </div>
      </header>
      {children}
      {note ? <div className="text-xs text-muted-foreground">{note}</div> : null}
    </section>
  );
}

export interface Columns {
  current: string;
  comparative: string | null;
}

/** One row group of a statement: its lines and total. */
export function SectionRows({ title, section, columns, totalLabel }: { title: string; section: Section; columns: Columns; totalLabel: string }) {
  const span = columns.comparative ? 3 : 2;
  return (
    <tbody>
      <tr>
        <th scope="rowgroup" colSpan={span} className="pb-1 pt-4 text-left text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </th>
      </tr>
      {section.lines.length === 0 ? (
        <tr>
          <td colSpan={span} className="py-1 pl-4 text-sm text-muted-foreground">
            Nothing in this period.
          </td>
        </tr>
      ) : (
        section.lines.map((line, index) => (
          <tr key={`${line.code ?? line.name}-${index.toString()}`} className="border-b border-dashed last:border-b-0">
            <th scope="row" className="py-1 pl-4 pr-3 text-left font-normal">
              {line.name}
              {line.code ? <span className="ml-2 font-mono text-xs text-muted-foreground">{line.code}</span> : null}
            </th>
            <td className="py-1 pr-3 text-right tabular-nums">{amount(line.amount)}</td>
            {columns.comparative ? <td className="py-1 text-right tabular-nums text-muted-foreground">{amount(line.comparativeAmount)}</td> : null}
          </tr>
        ))
      )}
      <TotalRow label={totalLabel} value={section.total} comparative={columns.comparative ? section.comparativeTotal : undefined} />
    </tbody>
  );
}

export function TotalRow({ label, value, comparative, strong = false }: { label: string; value: string; comparative?: string | null; strong?: boolean }) {
  return (
    <tr className={cn("border-t", strong && "border-double border-t-4")}>
      <th scope="row" className={cn("py-1.5 pr-3 text-left", strong ? "font-bold" : "font-semibold")}>
        {label}
      </th>
      <td className={cn("py-1.5 pr-3 text-right tabular-nums", strong ? "font-bold" : "font-semibold")}>{amount(value)}</td>
      {comparative !== undefined ? <td className={cn("py-1.5 text-right tabular-nums text-muted-foreground", strong ? "font-bold" : "font-semibold")}>{amount(comparative)}</td> : null}
    </tr>
  );
}

export function FigureRows({ label, figure, columns, strong = true }: { label: string; figure: Figure; columns: Columns; strong?: boolean }) {
  return (
    <tbody>
      <TotalRow label={label} value={figure.amount} comparative={columns.comparative ? figure.comparativeAmount : undefined} strong={strong} />
    </tbody>
  );
}

/** A statement's table: the caption, the column headings and the row groups given. */
export function StatementTable({ caption, columns, children }: { caption: string; columns: Columns; children: ReactNode }) {
  return (
    <div className="overflow-x-auto" role="region" aria-label={`${caption}, scrollable`} tabIndex={0}>
      <table className="w-full min-w-[22rem] text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b-2">
            <th scope="col" className="py-1 text-left font-medium text-muted-foreground">
              <span className="sr-only">Line</span>
            </th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">
              {columns.current}
            </th>
            {columns.comparative ? (
              <th scope="col" className="py-1 text-right font-medium text-muted-foreground">
                {columns.comparative}
              </th>
            ) : null}
          </tr>
        </thead>
        {children}
      </table>
    </div>
  );
}

export const periodLabel = (p: { from: string; to: string }) => `${formatDate(p.from)} – ${formatDate(p.to)}`;

// ---- The picker ----

export type PeriodMode = "mtd" | "month" | "year" | "custom";

export interface PeriodChoice {
  mode: PeriodMode;
  year: string;
  month: string;
  from: string;
  to: string;
  comparative: boolean;
}

export function initialPeriod(today: string): PeriodChoice {
  const [y = "2026", m = "1"] = today.split("-");
  return { mode: "mtd", year: y, month: String(Number.parseInt(m, 10)), from: `${y}-${m}-01`, to: today, comparative: true };
}

/** The query a period choice sends, or why it cannot be sent yet. */
export function periodQuery(choice: PeriodChoice): { query: ReportQuery } | { problem: string } {
  const comparative = choice.comparative ? undefined : "false";
  if (choice.mode === "mtd") return { query: { comparative } };
  if (choice.mode === "month") return { query: { year: choice.year, month: choice.month, comparative } };
  if (choice.mode === "year") return { query: { year: choice.year, comparative } };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(choice.from) || !/^\d{4}-\d{2}-\d{2}$/.test(choice.to)) return { problem: "Choose both dates." };
  if (choice.from > choice.to) return { problem: "The start date is after the end date." };
  return { query: { from: choice.from, to: choice.to, comparative } };
}

export function PeriodPicker({ value, onChange, withComparative = true }: { value: PeriodChoice; onChange: (next: PeriodChoice) => void; withComparative?: boolean }) {
  const ids = { mode: useId(), year: useId(), month: useId(), from: useId(), to: useId(), comparative: useId() };
  const [today] = useState(() => businessToday());
  const thisYear = Number.parseInt(today.slice(0, 4), 10);
  const years = Array.from({ length: 6 }, (_, i) => String(thisYear - i));
  return (
    <div role="group" aria-label="Period" className="no-print grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <SelectField id={ids.mode} label="Period" value={value.mode} onChange={(v) => onChange({ ...value, mode: v as PeriodMode })}>
        <option value="mtd">This month to date</option>
        <option value="month">A month</option>
        <option value="year">A year</option>
        <option value="custom">From – to</option>
      </SelectField>
      {value.mode === "month" || value.mode === "year" ? (
        <SelectField id={ids.year} label="Year" value={value.year} onChange={(v) => onChange({ ...value, year: v })}>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </SelectField>
      ) : null}
      {value.mode === "month" ? (
        <SelectField id={ids.month} label="Month" value={value.month} onChange={(v) => onChange({ ...value, month: v })}>
          {MONTHS.map((name, i) => (
            <option key={name} value={String(i + 1)}>
              {name}
            </option>
          ))}
        </SelectField>
      ) : null}
      {value.mode === "custom" ? (
        <>
          <TextField id={ids.from} label="From" type="date" max={today} value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} />
          <TextField id={ids.to} label="To" type="date" max={today} value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} />
        </>
      ) : null}
      {withComparative ? (
        <label htmlFor={ids.comparative} className="flex min-h-11 items-center gap-3 text-sm">
          <input id={ids.comparative} type="checkbox" className="size-5" checked={value.comparative} onChange={(e) => onChange({ ...value, comparative: e.target.checked })} />
          Compare with the period before
        </label>
      ) : null}
    </div>
  );
}

export function AsOfPicker({ value, onChange, comparative, onComparative }: { value: string; onChange: (next: string) => void; comparative: boolean; onComparative: (next: boolean) => void }) {
  const ids = { asOf: useId(), comparative: useId() };
  const [today] = useState(() => businessToday());
  return (
    <div role="group" aria-label="As at" className="no-print grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <TextField id={ids.asOf} label="As at" type="date" max={today} value={value} onChange={(e) => onChange(e.target.value)} />
      <label htmlFor={ids.comparative} className="flex min-h-11 items-center gap-3 text-sm">
        <input id={ids.comparative} type="checkbox" className="size-5" checked={comparative} onChange={(e) => onComparative(e.target.checked)} />
        Compare with the month-end before
      </label>
    </div>
  );
}

/** The loading / error / "fix the dates" states every report shares. */
export function ReportState<T>({ problem, report, render, label }: { problem: string | null; report: { isPending: boolean; isError: boolean; error: Error | null; data: T | undefined; refetch: () => unknown }; render: (data: T) => ReactNode; label: string }) {
  if (problem) {
    return (
      <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {problem}
      </p>
    );
  }
  if (report.isPending) return <LoadingState label={`Preparing the ${label}`} lines={6} />;
  if (report.isError || report.data === undefined) return <ErrorState title={`Couldn’t prepare the ${label}`} description={report.error?.message ?? "Please try again."} onRetry={() => void report.refetch()} />;
  return <Fragment>{render(report.data)}</Fragment>;
}
