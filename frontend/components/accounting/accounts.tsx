"use client";

import { Search } from "lucide-react";
import { useId, useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet } from "@/components/ui/sheet";
import { CLASS_LABEL, CLASS_ORDER, LEDGER_PAGE, SOURCE_LABEL, useAccountLedger, useAccounts, type Account } from "@/lib/accounting/accounting";
import { formatDate } from "@/lib/datetime";
import { formatKES } from "@/lib/money";
import { amount } from "./statements";

// The chart of accounts by class, and an account's ledger: every posting to it with the running
// balance the server carries. Nothing here is a balance the screen worked out.

function AccountLedger({ account }: { account: Account }) {
  const [page, setPage] = useState(0);
  const ledger = useAccountLedger(account.code, page);
  if (ledger.isPending) return <LoadingState label="Loading the ledger" lines={5} />;
  if (ledger.isError) return <ErrorState title="Couldn’t load the ledger" description={ledger.error.message} onRetry={() => void ledger.refetch()} />;
  const { rows, pagination, closingBalance } = ledger.data;
  const lastPage = Math.max(0, Math.ceil(pagination.total / LEDGER_PAGE) - 1);
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {CLASS_LABEL[account.accountClass]} · normal balance {account.normalBalance === "DEBIT" ? "debit" : "credit"}
      </p>
      <p className="text-sm">
        Balance now <span className="font-semibold tabular-nums">{amount(closingBalance)}</span>
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing has been posted to this account.</p>
      ) : (
        <div className="overflow-x-auto" role="region" aria-label="Account ledger, scrollable" tabIndex={0}>
          <table className="w-full min-w-[32rem] text-sm">
            <caption className="sr-only">Ledger for {account.code} {account.name}</caption>
            <thead>
              <tr className="border-b-2 text-left">
                <th scope="col" className="py-1 font-medium">Date</th>
                <th scope="col" className="py-1 font-medium">Entry</th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">Debit</th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">Credit</th>
                <th scope="col" className="py-1 text-right font-medium">Balance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.entryId}-${r.lineNumber.toString()}`} className="border-b border-dashed last:border-b-0">
                  <td className="py-1 whitespace-nowrap">{formatDate(r.entryDate)}</td>
                  <th scope="row" className="py-1 pr-3 text-left font-normal">
                    <span className="font-mono text-xs">{r.entryNumber}</span> <span className="text-muted-foreground">{SOURCE_LABEL[r.source]}</span>
                    <span className="block text-xs text-muted-foreground">{r.description}</span>
                  </th>
                  <td className="py-1 pr-3 text-right tabular-nums">{r.debit === "0" ? "" : formatKES(r.debit)}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{r.credit === "0" ? "" : formatKES(r.credit)}</td>
                  <td className="py-1 text-right tabular-nums">{amount(r.runningBalance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pagination.total > LEDGER_PAGE ? (
        <nav aria-label="Ledger pages" className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">{`${(page * LEDGER_PAGE + 1).toString()}–${Math.min(pagination.total, (page + 1) * LEDGER_PAGE).toString()} of ${pagination.total.toString()}`}</p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="h-11" disabled={page === 0} onClick={() => setPage(page - 1)}>
              Earlier
            </Button>
            <Button type="button" variant="outline" className="h-11" disabled={page >= lastPage} onClick={() => setPage(page + 1)}>
              Later
            </Button>
          </div>
        </nav>
      ) : null}
    </div>
  );
}

export function AccountsView() {
  const ids = { search: useId() };
  const accounts = useAccounts();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<Account | null>(null);
  if (accounts.isPending) return <LoadingState label="Loading the chart of accounts" lines={6} />;
  if (accounts.isError) return <ErrorState title="Couldn’t load the chart of accounts" description={accounts.error.message} onRetry={() => void accounts.refetch()} />;
  const needle = search.trim().toLowerCase();
  const shown = accounts.data.data.filter((a) => needle === "" || a.code.includes(needle) || a.name.toLowerCase().includes(needle));
  return (
    <div className="space-y-4">
      <div className="max-w-sm space-y-2">
        <Label htmlFor={ids.search}>Find an account</Label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input id={ids.search} type="search" className="h-11 pl-9" placeholder="Code or name" autoComplete="off" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>
      {shown.length === 0 ? (
        <EmptyState title="No accounts match" description={`Nothing matches “${search.trim()}”.`} />
      ) : (
        CLASS_ORDER.map((cls) => {
          const inClass = shown.filter((a) => a.accountClass === cls);
          if (inClass.length === 0) return null;
          return (
            <section key={cls} aria-labelledby={`class-${cls}`} className="space-y-2">
              <h2 id={`class-${cls}`} className="font-medium">
                {CLASS_LABEL[cls]}
              </h2>
              <ul aria-label={CLASS_LABEL[cls]} className="divide-y rounded-lg border">
                {inClass.map((a) => (
                  <li key={a.code}>
                    <button type="button" onClick={() => setOpen(a)} className="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      <span className="w-12 font-mono text-xs">{a.code}</span>
                      <span className="flex-1">{a.name}</span>
                      {a.isActive ? null : <span className="text-xs text-muted-foreground">inactive</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
      {open ? (
        <Sheet title={`${open.code} ${open.name}`} onClose={() => setOpen(null)} wide>
          <AccountLedger account={open} />
        </Sheet>
      ) : null}
    </div>
  );
}
