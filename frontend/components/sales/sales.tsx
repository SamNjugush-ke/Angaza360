"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useState, type ReactNode } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Role } from "@/lib/auth/landing";
import { useDebounced } from "@/lib/catalog/hooks";
import { businessToday, formatDateTime, toBusinessDate } from "@/lib/datetime";
import { formatKES } from "@/lib/money";
import { fetchCustomers } from "@/lib/pos/api";
import { useCurrentShift } from "@/lib/pos/hooks";
import type { Customer } from "@/lib/pos/types";
import { businessTimeOf, canReadCustomers, hasTill, PAGE_SIZE, rangeProblem, salesKeys, salesQuery, useSales, type SaleRow, type SalesFilters } from "@/lib/sales/sales";
import { cn } from "@/lib/utils";
import { SaleStatusBadge, TenderBadges } from "./badges";
import { SalesDetailSheet } from "./sale-sheet";

// SALES & RECEIPTS. Every sale, filtered and paged by the SERVER: the sale number (q), the status,
// the customer, the business days it happened on (Africa/Nairobi) — or only the caller's open
// shift. The total is the filtered count. Desktop shows a table, a phone a list of cards. A sale
// opens in a side sheet, so closing it returns to the list exactly as it was filtered and paged.

const SELECT_CLASS =
  "flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:text-sm";

function defaultsFor(today: string): SalesFilters {
  return { q: "", status: "", customerId: "", from: today, to: today, currentShift: false };
}

/** The business day `days` before `day` ("YYYY-MM-DD"), counted on the calendar. */
function daysBefore(day: string, days: number): string {
  const [y = "1970", m = "01", d = "01"] = day.split("-");
  return toBusinessDate(new Date(Date.UTC(Number(y), Number(m) - 1, Number(d) - days, 12)));
}

interface FiltersProps {
  value: SalesFilters;
  onChange: (next: SalesFilters) => void;
  customers: readonly Customer[] | null;
  showShift: boolean;
}

function Filters({ value, onChange, customers, showShift }: FiltersProps) {
  const ids = { q: useId(), status: useId(), from: useId(), to: useId(), find: useId(), customer: useId(), shift: useId(), dateNote: useId() };
  const [find, setFind] = useState("");
  const matching = useMemo(() => {
    const needle = find.trim().toLowerCase();
    const all = customers ?? [];
    const shown = needle === "" ? all : all.filter((c) => c.name.toLowerCase().includes(needle) || (c.phone ?? "").includes(needle));
    // The chosen customer stays an option even when the search no longer matches them.
    const chosen = all.find((c) => c.id === value.customerId);
    return chosen && !shown.includes(chosen) ? [chosen, ...shown] : shown;
  }, [customers, find, value.customerId]);

  return (
    <div role="search" aria-label="Filter sales" className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-2">
          <Label htmlFor={ids.q}>Sale number</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input id={ids.q} type="search" className="h-11 pl-9" placeholder="e.g. 000042" autoComplete="off" value={value.q} onChange={(event) => onChange({ ...value, q: event.target.value })} />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor={ids.status}>Status</Label>
          <select id={ids.status} className={SELECT_CLASS} value={value.status} onChange={(event) => onChange({ ...value, status: event.target.value as SalesFilters["status"] })}>
            <option value="">All</option>
            <option value="COMPLETED">Completed</option>
            <option value="VOIDED">Voided</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={ids.from}>From</Label>
          <Input
            id={ids.from}
            type="date"
            className="h-11"
            value={value.from}
            disabled={value.currentShift}
            aria-describedby={value.currentShift ? ids.dateNote : undefined}
            onChange={(event) => onChange({ ...value, from: event.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={ids.to}>To</Label>
          <Input
            id={ids.to}
            type="date"
            className="h-11"
            value={value.to}
            disabled={value.currentShift}
            aria-describedby={value.currentShift ? ids.dateNote : undefined}
            onChange={(event) => onChange({ ...value, to: event.target.value })}
          />
        </div>
      </div>
      <div className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {customers !== null ? (
          <>
            <div className="space-y-2">
              <Label htmlFor={ids.find}>Find a customer</Label>
              <Input id={ids.find} type="search" className="h-11" placeholder="Name or phone" autoComplete="off" value={find} onChange={(event) => setFind(event.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor={ids.customer}>Customer</Label>
              <select id={ids.customer} className={SELECT_CLASS} value={value.customerId} onChange={(event) => onChange({ ...value, customerId: event.target.value })}>
                <option value="">All customers</option>
                {matching.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.phone ? ` · ${c.phone}` : ""}
                  </option>
                ))}
              </select>
            </div>
          </>
        ) : null}
        {showShift ? (
          <div className="space-y-1 lg:col-span-2">
            <label htmlFor={ids.shift} className="flex min-h-11 items-center gap-3 text-sm font-medium">
              <input id={ids.shift} type="checkbox" className="size-5" checked={value.currentShift} onChange={(event) => onChange({ ...value, currentShift: event.target.checked })} />
              Current shift only
            </label>
            {value.currentShift ? (
              <p id={ids.dateNote} className="text-xs text-muted-foreground">
                Showing your open shift, whatever day it started; the dates don&rsquo;t apply.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function customerName(sale: SaleRow, names: ReadonlyMap<string, string> | null): string {
  if (sale.customerId === null) return "Walk-in";
  return names?.get(sale.customerId) ?? "Account customer";
}

interface RowsProps {
  sales: readonly SaleRow[];
  names: ReadonlyMap<string, string> | null;
  onOpen: (sale: SaleRow) => void;
}

function SalesTable({ sales, names, onOpen }: RowsProps) {
  return (
    <table className="hidden w-full text-sm md:table">
      <caption className="sr-only">Sales</caption>
      <thead>
        <tr className="border-b text-left text-muted-foreground">
          <th scope="col" className="py-2 pr-4 font-medium">Sale</th>
          <th scope="col" className="py-2 pr-4 font-medium">When</th>
          <th scope="col" className="py-2 pr-4 font-medium">Customer</th>
          <th scope="col" className="py-2 pr-4 text-right font-medium">Total (KES)</th>
          <th scope="col" className="py-2 pr-4 font-medium">Paid by</th>
          <th scope="col" className="py-2 font-medium">Status</th>
        </tr>
      </thead>
      <tbody>
        {sales.map((sale) => (
          <tr key={sale.id} className="border-b last:border-b-0">
            <td className="py-1 pr-4">
              <button
                type="button"
                onClick={() => onOpen(sale)}
                className="min-h-11 rounded-sm text-left font-mono text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {sale.saleNumber}
              </button>
            </td>
            <td className="py-1 pr-4 whitespace-nowrap">{formatDateTime(businessTimeOf(sale))}</td>
            <td className="py-1 pr-4">{customerName(sale, names)}</td>
            <td className={cn("py-1 pr-4 text-right tabular-nums", sale.status === "VOIDED" && "text-muted-foreground line-through")}>{formatKES(sale.total)}</td>
            <td className="py-1 pr-4">
              <TenderBadges tenders={sale.tenders} />
            </td>
            <td className="py-1">
              <SaleStatusBadge status={sale.status} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SalesCards({ sales, names, onOpen }: RowsProps) {
  return (
    <ul className="space-y-2 md:hidden" aria-label="Sales">
      {sales.map((sale) => (
        <li key={sale.id}>
          <button
            type="button"
            onClick={() => onOpen(sale)}
            className="flex min-h-11 w-full flex-col gap-2 rounded-lg border p-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex w-full items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="block font-mono text-xs font-medium">{sale.saleNumber}</span>
                <span className="block text-xs text-muted-foreground">
                  {formatDateTime(businessTimeOf(sale))} · {customerName(sale, names)}
                </span>
              </span>
              <span className={cn("shrink-0 font-medium tabular-nums", sale.status === "VOIDED" && "text-muted-foreground line-through")}>KES {formatKES(sale.total)}</span>
            </span>
            <span className="flex flex-wrap items-center gap-2">
              <SaleStatusBadge status={sale.status} />
              <TenderBadges tenders={sale.tenders} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Pagination({ page, total, onPage, busy }: { page: number; total: number; onPage: (page: number) => void; busy: boolean }) {
  const first = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const last = Math.min(total, (page + 1) * PAGE_SIZE);
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-3 pt-2">
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {`Showing ${first.toString()}–${last.toString()} of ${total.toString()} ${total === 1 ? "sale" : "sales"}`}
      </p>
      <div className="flex gap-2">
        <Button type="button" variant="outline" className="h-11" disabled={busy || page === 0} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button type="button" variant="outline" className="h-11" disabled={busy || page >= lastPage} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </nav>
  );
}

export interface SalesProps {
  role: Role;
}

export function Sales({ role }: SalesProps) {
  const client = useQueryClient();
  const [today] = useState(() => businessToday());
  const defaults = useMemo(() => defaultsFor(today), [today]);
  const [typed, setTyped] = useState<SalesFilters>(defaults);
  const q = useDebounced(typed.q, 300);
  const filters: SalesFilters = { ...typed, q };
  const filterKey = JSON.stringify(filters);
  // The page belongs to one set of filters: changing any filter starts again at page 1.
  const [paging, setPaging] = useState({ key: filterKey, page: 0 });
  const page = paging.key === filterKey ? paging.page : 0;
  const [open, setOpen] = useState<SaleRow | null>(null);

  const customersAllowed = canReadCustomers(role);
  const customers = useQuery({ queryKey: ["pos", "customers"], queryFn: fetchCustomers, enabled: customersAllowed });
  const names = useMemo(() => (customers.data ? new Map(customers.data.data.map((c) => [c.id, c.name])) : null), [customers.data]);

  const showShift = hasTill(role);
  const shift = useCurrentShift(showShift && filters.currentShift);
  const problem = rangeProblem(filters);
  const query = problem === null ? salesQuery(filters, page, shift.data?.id ?? null) : null;
  const sales = useSales(query);

  const isDefault = filterKey === JSON.stringify(defaults);
  const clear = () => setTyped(defaults);

  let list: ReactNode;
  if (problem !== null) {
    list = (
      <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {problem} Change the dates to see sales.
      </p>
    );
  } else if (filters.currentShift && shift.isPending) {
    list = <LoadingState label="Checking your shift" />;
  } else if (filters.currentShift && shift.isError) {
    list = <ErrorState title="Couldn’t check your shift" description={shift.error.message} onRetry={() => void shift.refetch()} />;
  } else if (filters.currentShift && shift.data === null) {
    list = (
      <EmptyState
        title="You have no open shift"
        description="Open a shift on the till to see its sales here, or look at sales by date instead."
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button type="button" variant="outline" className="h-11" onClick={() => setTyped({ ...typed, currentShift: false })}>
              Show sales by date
            </Button>
            <Button asChild className="h-11">
              <Link href="/pos">Go to the till</Link>
            </Button>
          </div>
        }
      />
    );
  } else if (sales.isPending) {
    list = <LoadingState label="Loading sales" lines={6} />;
  } else if (sales.isError) {
    list = <ErrorState title="Couldn’t load sales" description={sales.error.message} onRetry={() => void sales.refetch()} />;
  } else if (sales.data.pagination.total === 0) {
    list = isDefault ? (
      <EmptyState
        title="No sales today yet"
        description="Sales rung at the till appear here. Look further back to find older sales."
        action={
          <Button type="button" variant="outline" className="h-11" onClick={() => setTyped({ ...defaults, from: daysBefore(today, 6) })}>
            Show the last 7 days
          </Button>
        }
      />
    ) : (
      <EmptyState
        title="No sales match"
        description="Try a different sale number or dates, or clear the filters."
        action={
          <Button type="button" variant="outline" className="h-11" onClick={clear}>
            Clear filters
          </Button>
        }
      />
    );
  } else {
    list = (
      <>
        <SalesTable sales={sales.data.data} names={names} onOpen={setOpen} />
        <SalesCards sales={sales.data.data} names={names} onOpen={setOpen} />
        <Pagination page={page} total={sales.data.pagination.total} busy={sales.isPlaceholderData} onPage={(next) => setPaging({ key: filterKey, page: next })} />
      </>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-display text-2xl font-semibold">Sales & receipts</h1>
          <p className="text-sm text-muted-foreground">Find a sale, reprint its receipt{role === "MSME_OWNER" || role === "MSME_MANAGER" ? ", or void it" : ""}.</p>
        </div>
        {!isDefault ? (
          <Button type="button" variant="outline" className="h-11" onClick={clear}>
            Clear filters
          </Button>
        ) : null}
      </div>

      <Filters value={typed} onChange={setTyped} customers={customersAllowed ? (customers.data?.data ?? []) : null} showShift={showShift} />

      <section aria-label="Sales list" aria-busy={sales.isFetching} className={cn("space-y-3", sales.isPlaceholderData && "opacity-70")}>
        {list}
      </section>

      {open ? (
        <SalesDetailSheet
          sale={open}
          role={role}
          onClose={() => {
            setOpen(null);
            void client.invalidateQueries({ queryKey: salesKeys.all });
          }}
        />
      ) : null}
    </div>
  );
}
