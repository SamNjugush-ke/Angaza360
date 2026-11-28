"use client";

import { useId, useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { Done } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { periodName, setPeriod, useInvalidateAccounting, usePeriods, type AccountingPermissions, type Period } from "@/lib/accounting/accounting";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { formatDateTime } from "@/lib/datetime";
import { cn } from "@/lib/utils";

// Accounting periods — one per month the books have been posted in. Closing a month locks it: no
// entry may be posted into it afterwards (the owner or the accountant closes; the server refuses a
// close while an offline till could still deliver sales dated inside it, and says which). Reopening
// is the owner's alone, because it unlocks figures that may already have been reported.

function Change({ period, action, onDone }: { period: Period; action: "close" | "reopen"; onDone: (note: string) => void }) {
  const ids = { title: useId(), body: useId() };
  const invalidate = useInvalidateAccounting();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const name = periodName(period.year, period.month);
  if (!asking) {
    return (
      <Button type="button" variant="outline" className="h-11" onClick={() => setAsking(true)} aria-label={`${action === "close" ? "Close" : "Reopen"} ${name}`}>
        {action === "close" ? "Close" : "Reopen"}
      </Button>
    );
  }
  async function confirm() {
    setSaving(true);
    setError(null);
    try {
      await setPeriod(period.year, period.month, action);
      await invalidate();
      setAsking(false);
      onDone(`${name} is ${action === "close" ? "closed" : "open again"}.`);
    } catch (failure) {
      setError(failure instanceof ApiHttpError ? failure.message : "That could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div role="alertdialog" aria-labelledby={ids.title} aria-describedby={ids.body} className="w-full space-y-2 rounded-md border p-3">
      <p id={ids.title} className="font-medium">
        {action === "close" ? `Close ${name}?` : `Reopen ${name}?`}
      </p>
      <p id={ids.body} className="text-sm">
        {action === "close" ? "Nothing can be posted into it afterwards. Late documents for it are posted in an open month." : "Postings into it become possible again, and figures already reported for it may change."}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button type="button" variant="outline" className="h-11" onClick={() => setAsking(false)} disabled={saving} data-autofocus>
          Back
        </Button>
        <Button type="button" className="h-11" onClick={() => void confirm()} disabled={saving}>
          {saving ? "Saving…" : action === "close" ? "Yes, close it" : "Yes, reopen it"}
        </Button>
      </div>
    </div>
  );
}

export function PeriodsView({ permissions }: { permissions: AccountingPermissions }) {
  const periods = usePeriods();
  const [notice, setNotice] = useState<string | null>(null);
  if (periods.isPending) return <LoadingState label="Loading periods" lines={4} />;
  if (periods.isError) return <ErrorState title="Couldn’t load periods" description={periods.error.message} onRetry={() => void periods.refetch()} />;
  const rows = [...periods.data.data].sort((a, b) => b.year - a.year || b.month - a.month);
  return (
    <div className="space-y-4">
      {notice ? <Done>{notice}</Done> : null}
      {rows.length === 0 ? (
        <EmptyState title="No periods yet" description="A month appears here once something is posted in it." />
      ) : (
        <ul aria-label="Accounting periods" className="space-y-2">
          {rows.map((p) => {
            const closed = p.status === "CLOSED";
            return (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
                <span>
                  <span className="font-medium">{periodName(p.year, p.month)}</span>{" "}
                  <span className={cn("ml-2 rounded-full border px-2 py-0.5 text-xs font-medium", closed ? "bg-muted" : "border-emerald-700/40 bg-emerald-700/10")}>{closed ? "Closed" : "Open"}</span>
                  {closed && p.closedAt ? <span className="block text-xs text-muted-foreground">Closed {formatDateTime(p.closedAt)}</span> : null}
                </span>
                {!closed && permissions.canClosePeriod ? <Change period={p} action="close" onDone={setNotice} /> : null}
                {closed && permissions.canReopenPeriod ? <Change period={p} action="reopen" onDone={setNotice} /> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
