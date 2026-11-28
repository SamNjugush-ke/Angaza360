"use client";

import { useId, type ReactNode } from "react";
import { TextField } from "@/components/auth/form-bits";
import { Button } from "@/components/ui/button";
import { checkAllocation, allocateOldestFirst, type OpenItem } from "@/lib/allocation";
import { formatDate } from "@/lib/datetime";
import { formatKES } from "@/lib/money";
import { cn } from "@/lib/utils";

// The pieces the receivables and payables screens share: an aging table (AR by sale date, AP by due
// date — the buckets are the server's), a statement with its running balance, and the allocation
// editor that spreads a payment across open items (oldest first by default, editable, checked to
// the cent). Every figure shown is the server's or the person's own typing — nothing is derived.

export interface Buckets {
  current: string;
  days1To30: string;
  days31To60: string;
  days61To90: string;
  over90: string;
}

export interface AgingRow extends Buckets {
  id: string;
  name: string;
  total: string;
  count: number;
}

const BUCKETS: ReadonlyArray<[keyof Buckets, string]> = [
  ["current", "Current"],
  ["days1To30", "1–30 days"],
  ["days31To60", "31–60 days"],
  ["days61To90", "61–90 days"],
  ["over90", "Over 90 days"],
];

export function AgingTable({ caption, rows, totals, grandTotal, currentLabel, onOpen, countLabel }: { caption: string; rows: readonly AgingRow[]; totals: Buckets; grandTotal: string; currentLabel: string; onOpen?: (row: AgingRow) => void; countLabel: string }) {
  const labels = BUCKETS.map(([key, label]) => [key, key === "current" ? currentLabel : label] as const);
  return (
    <div className="space-y-3">
      <div className="hidden overflow-x-auto md:block" role="region" aria-label={`${caption}, scrollable`} tabIndex={0}>
        <table className="w-full min-w-[44rem] text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th scope="col" className="py-2 pr-3 font-medium">Name</th>
              {labels.map(([key, label]) => (
                <th key={key} scope="col" className="py-2 pr-3 text-right font-medium">
                  {label}
                </th>
              ))}
              <th scope="col" className="py-2 text-right font-medium">Total (KES)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b last:border-b-0">
                <th scope="row" className="py-1 pr-3 text-left font-normal">
                  {onOpen ? (
                    <button type="button" onClick={() => onOpen(row)} className="min-h-11 rounded-sm text-left font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      {row.name}
                    </button>
                  ) : (
                    row.name
                  )}
                  <span className="block text-xs text-muted-foreground">
                    {row.count.toString()} {countLabel}
                  </span>
                </th>
                {labels.map(([key]) => (
                  <td key={key} className={cn("py-1 pr-3 text-right tabular-nums", key === "over90" && row.over90 !== "0" && "font-semibold text-destructive")}>
                    {row[key] === "0" ? "—" : formatKES(row[key])}
                  </td>
                ))}
                <td className="py-1 text-right font-medium tabular-nums">{formatKES(row.total)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold">
              <th scope="row" className="py-2 pr-3 text-left">All</th>
              {labels.map(([key]) => (
                <td key={key} className="py-2 pr-3 text-right tabular-nums">
                  {formatKES(totals[key])}
                </td>
              ))}
              <td className="py-2 text-right tabular-nums">{formatKES(grandTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <ul className="space-y-2 md:hidden" aria-label={caption}>
        {rows.map((row) => {
          const body = (
            <>
              <span className="flex w-full justify-between gap-3 font-medium">
                <span>{row.name}</span>
                <span className="tabular-nums">KES {formatKES(row.total)}</span>
              </span>
              <span className="text-xs text-muted-foreground">
                {labels
                  .filter(([key]) => row[key] !== "0")
                  .map(([key, label]) => `${label} ${formatKES(row[key])}`)
                  .join(" · ")}
              </span>
            </>
          );
          return (
            <li key={row.id}>
              {onOpen ? (
                <button type="button" onClick={() => onOpen(row)} className="flex min-h-11 w-full flex-col gap-1 rounded-lg border p-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {body}
                </button>
              ) : (
                <div className="flex flex-col gap-1 rounded-lg border p-3">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-sm font-medium" aria-live="polite">
        Total outstanding: KES {formatKES(grandTotal)}
      </p>
    </div>
  );
}

export interface StatementLine {
  key: string;
  date: string;
  reference: string;
  description: string;
  charged: string;
  credited: string;
  runningBalance: string;
  note?: string;
}

export function StatementTable({ caption, lines, chargedLabel, creditedLabel }: { caption: string; lines: readonly StatementLine[]; chargedLabel: string; creditedLabel: string }) {
  if (lines.length === 0) return <p className="text-sm text-muted-foreground">Nothing on the account yet.</p>;
  return (
    <div className="overflow-x-auto" role="region" aria-label={`${caption}, scrollable`} tabIndex={0}>
      <table className="w-full min-w-[34rem] text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th scope="col" className="py-1 pr-3 font-medium">Date</th>
            <th scope="col" className="py-1 pr-3 font-medium">Item</th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">{chargedLabel}</th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">{creditedLabel}</th>
            <th scope="col" className="py-1 text-right font-medium">Balance</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.key} className="border-b last:border-b-0">
              <td className="py-1.5 pr-3 whitespace-nowrap">{formatDate(line.date)}</td>
              <td className="py-1.5 pr-3">
                <span className="font-medium">{line.reference}</span> <span className="text-muted-foreground">{line.description}</span>
                {line.note ? <span className="block text-xs text-muted-foreground">{line.note}</span> : null}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{line.charged === "0" ? "" : formatKES(line.charged)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{line.credited === "0" ? "" : formatKES(line.credited)}</td>
              <td className="py-1.5 text-right tabular-nums">{formatKES(line.runningBalance)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface AllocationItem extends OpenItem {
  label: string;
  detail: string;
}

/** Spread a payment across open items: oldest first on request, each share editable, checked to the cent. */
export function AllocationEditor({ items, shares, onChange, amountCents, legend }: { items: readonly AllocationItem[]; shares: Readonly<Record<string, string>>; onChange: (shares: Record<string, string>) => void; amountCents: bigint | null; legend: string }) {
  const statusId = useId();
  const check = checkAllocation(items, shares, amountCents);
  let summary: ReactNode;
  if (amountCents === null || amountCents <= 0n) summary = "Enter the amount first.";
  else if (check.unallocated === 0n) summary = `All KES ${formatKES(amountCents)} is allocated.`;
  else if (check.unallocated > 0n) summary = `KES ${formatKES(check.unallocated)} still to allocate — every shilling must go to an item.`;
  else summary = `Allocated KES ${formatKES(-check.unallocated)} more than the amount.`;
  return (
    <fieldset className="space-y-3">
      <legend className="font-medium">{legend}</legend>
      <Button type="button" variant="outline" className="h-11" disabled={amountCents === null || amountCents <= 0n} onClick={() => onChange(allocateOldestFirst(items, amountCents ?? 0n))}>
        Allocate oldest first
      </Button>
      <ul className="space-y-2" aria-describedby={statusId}>
        {items.map((item) => (
          <li key={item.id} className="rounded-lg border p-3">
            <TextField
              id={`alloc-${item.id}`}
              label={`${item.label} — pay (KES)`}
              hint={item.detail}
              inputMode="decimal"
              autoComplete="off"
              value={shares[item.id] ?? ""}
              error={check.problems[item.id]}
              onChange={(e) => onChange({ ...shares, [item.id]: e.target.value })}
            />
          </li>
        ))}
      </ul>
      <p id={statusId} aria-live="polite" className={cn("text-sm font-medium", check.ok ? "text-foreground" : "text-destructive")}>
        {summary}
      </p>
    </fieldset>
  );
}
