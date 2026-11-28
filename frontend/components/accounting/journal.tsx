"use client";

import { Plus, Trash2 } from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { FormAlert, TextField } from "@/components/auth/form-bits";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { Done, SelectField } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import {
  CLASS_LABEL,
  CLASS_ORDER,
  CONTROL_ACCOUNTS,
  ENTRIES_PAGE,
  postEntry,
  reverseEntry,
  SOURCE_LABEL,
  useAccounts,
  useEntries,
  useEntry,
  useInvalidateAccounting,
  type AccountingPermissions,
  type EntryRow,
} from "@/lib/accounting/accounting";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { businessToday, formatDate, toBusinessDate } from "@/lib/datetime";
import { centsToAmount, formatKES, parseCents, parseMajorToCents } from "@/lib/money";

// The journal: every posted entry, newest first; an entry's balanced lines; a MANUAL entry posted by
// the owner or accountant — debits must equal credits, checked here to the cent and enforced by the
// database — and a reversal, which posts the mirror image and never edits the original. Entries are
// immutable; a closed period refuses a posting into it, and the server says so.

const sumDebits = (lines: ReadonlyArray<{ debit: string }>) => lines.reduce((sum, l) => sum + parseCents(l.debit), 0n);

function cents(typed: string): bigint | null {
  if (typed.trim() === "") return 0n;
  try {
    return parseMajorToCents(typed);
  } catch {
    return null;
  }
}

interface DraftLine {
  key: string;
  accountCode: string;
  debit: string;
  credit: string;
  memo: string;
}
let next = 0;
const blank = (): DraftLine => {
  next += 1;
  return { key: `j${next.toString()}`, accountCode: "", debit: "", credit: "", memo: "" };
};

function EntryForm({ onPosted }: { onPosted: (entry: { id: string; entryNumber: string }) => void }) {
  const ids = { date: useId(), description: useId(), reference: useId(), error: useId(), status: useId() };
  const accounts = useAccounts();
  const invalidate = useInvalidateAccounting();
  const [today] = useState(() => businessToday());
  const [entryDate, setEntryDate] = useState(today);
  const [description, setDescription] = useState("");
  const [reference, setReference] = useState("");
  const [lines, setLines] = useState<DraftLine[]>(() => [blank(), blank()]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const usable = (accounts.data?.data ?? []).filter((a) => a.isActive && !CONTROL_ACCOUNTS.has(a.code));
  let debits = 0n;
  let credits = 0n;
  let unreadable = false;
  for (const l of lines) {
    const d = cents(l.debit);
    const c = cents(l.credit);
    if (d === null || c === null) unreadable = true;
    else {
      debits += d;
      credits += c;
    }
  }
  const difference = debits - credits;
  const update = (key: string, change: Partial<DraftLine>) => setLines(lines.map((l) => (l.key === key ? { ...l, ...change } : l)));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (description.trim() === "") found.description = "Say what the entry is for.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) found.date = "Choose the entry date.";
    const used = lines.filter((l) => l.accountCode !== "" || l.debit.trim() !== "" || l.credit.trim() !== "");
    for (const l of used) {
      const d = cents(l.debit);
      const c = cents(l.credit);
      if (l.accountCode === "") found[`a-${l.key}`] = "Choose the account.";
      if (d === null || c === null) found[`m-${l.key}`] = "Enter amounts in shillings, e.g. 1,250.50.";
      else if ((d > 0n) === (c > 0n)) found[`m-${l.key}`] = "Enter a debit or a credit — one, not both.";
    }
    if (used.length < 2) found.lines = "An entry needs at least two lines.";
    else if (!unreadable && difference !== 0n) found.lines = "Debits and credits must be equal before the entry can be posted.";
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    setError(null);
    try {
      const posted = await postEntry({
        entryDate,
        description: description.trim(),
        ...(reference.trim() ? { reference: reference.trim() } : {}),
        source: "MANUAL",
        lines: used.map((l) => {
          const d = cents(l.debit) ?? 0n;
          const c = cents(l.credit) ?? 0n;
          return { accountCode: l.accountCode, ...(d > 0n ? { debit: centsToAmount(d) } : { credit: centsToAmount(c) }), ...(l.memo.trim() ? { memo: l.memo.trim() } : {}) };
        }),
      });
      await invalidate();
      onPosted(posted);
    } catch (failure) {
      setError(failure instanceof ApiHttpError ? failure.message : "The entry could not be posted. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="space-y-4">
      {error ? <FormAlert id={ids.error}>{error}</FormAlert> : null}
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField id={ids.date} label="Entry date" type="date" value={entryDate} error={errors.date} onChange={(e) => setEntryDate(e.target.value)} />
        <div className="sm:col-span-2">
          <TextField id={ids.description} label="Description" autoComplete="off" value={description} error={errors.description} onChange={(e) => setDescription(e.target.value)} data-autofocus />
        </div>
      </div>
      <TextField id={ids.reference} label="Reference" optional autoComplete="off" value={reference} onChange={(e) => setReference(e.target.value)} />
      <fieldset className="space-y-3">
        <legend className="font-medium">Lines</legend>
        <p className="text-xs text-muted-foreground">
          Inventory (1200), receivables (1100), payables (2000) and goods received not invoiced (2050) are kept by their own modules and are not offered here.
        </p>
        <ul aria-label="Entry lines" className="space-y-2">
          {lines.map((l, index) => (
            <li key={l.key} className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">Line {(index + 1).toString()}</p>
                {lines.length > 2 ? (
                  <button type="button" onClick={() => setLines(lines.filter((x) => x.key !== l.key))} aria-label={`Remove line ${(index + 1).toString()}`} className="flex size-11 items-center justify-center rounded-md text-destructive hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                ) : null}
              </div>
              <div className="space-y-1">
                <SelectField id={`acct-${l.key}`} label={`Line ${(index + 1).toString()} account`} value={l.accountCode} onChange={(v) => update(l.key, { accountCode: v })}>
                  <option value="">Choose an account</option>
                  {CLASS_ORDER.map((cls) => (
                    <optgroup key={cls} label={CLASS_LABEL[cls]}>
                      {usable
                        .filter((a) => a.accountClass === cls)
                        .map((a) => (
                          <option key={a.code} value={a.code}>
                            {a.code} {a.name}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </SelectField>
                {errors[`a-${l.key}`] ? <p className="text-sm text-destructive">{errors[`a-${l.key}`]}</p> : null}
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <TextField id={`dr-${l.key}`} label={`Line ${(index + 1).toString()} debit (KES)`} inputMode="decimal" autoComplete="off" value={l.debit} onChange={(e) => update(l.key, { debit: e.target.value })} />
                <TextField id={`cr-${l.key}`} label={`Line ${(index + 1).toString()} credit (KES)`} inputMode="decimal" autoComplete="off" value={l.credit} onChange={(e) => update(l.key, { credit: e.target.value })} />
                <TextField id={`memo-${l.key}`} label={`Line ${(index + 1).toString()} memo`} optional autoComplete="off" value={l.memo} onChange={(e) => update(l.key, { memo: e.target.value })} />
              </div>
              {errors[`m-${l.key}`] ? <p className="text-sm text-destructive">{errors[`m-${l.key}`]}</p> : null}
            </li>
          ))}
        </ul>
        <Button type="button" variant="outline" className="h-11" onClick={() => setLines([...lines, blank()])}>
          <Plus aria-hidden /> Add a line
        </Button>
        <dl id={ids.status} aria-live="polite" className="grid grid-cols-3 gap-2 rounded-md bg-muted p-3 text-sm">
          <div>
            <dt className="text-muted-foreground">Debits</dt>
            <dd className="font-medium tabular-nums">KES {formatKES(debits)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Credits</dt>
            <dd className="font-medium tabular-nums">KES {formatKES(credits)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Difference</dt>
            <dd className={difference === 0n ? "font-medium tabular-nums" : "font-semibold tabular-nums text-destructive"}>{difference === 0n ? "Balanced" : `KES ${formatKES(difference < 0n ? -difference : difference)} ${difference > 0n ? "more debit" : "more credit"}`}</dd>
          </div>
        </dl>
        {errors.lines ? (
          <p role="alert" className="text-sm text-destructive">
            {errors.lines}
          </p>
        ) : null}
      </fieldset>
      <Button type="submit" className="h-11" disabled={saving}>
        {saving ? "Posting…" : "Post entry"}
      </Button>
    </form>
  );
}

function Reverse({ entryId, onDone }: { entryId: string; onDone: (entryNumber: string) => void }) {
  const ids = { reason: useId(), title: useId() };
  const invalidate = useInvalidateAccounting();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (!asking) {
    return (
      <Button type="button" variant="outline" className="h-11" onClick={() => setAsking(true)}>
        Reverse entry
      </Button>
    );
  }
  async function confirm() {
    if (reason.trim() === "") {
      setProblem("Give a reason — it is kept with the reversal.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const reversal = await reverseEntry(entryId, reason.trim());
      await invalidate();
      onDone(reversal.entryNumber);
    } catch (failure) {
      setError(failure instanceof ApiHttpError ? failure.message : "The entry could not be reversed. Please try again.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div role="alertdialog" aria-labelledby={ids.title} className="w-full space-y-2 rounded-md border p-3">
      <p id={ids.title} className="font-medium">
        Reverse this entry?
      </p>
      <p className="text-sm">A new entry posts the exact opposite of every line. The original stays on record; nothing is edited.</p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <TextField id={ids.reason} label="Reason for the reversal" autoComplete="off" value={reason} error={problem ?? undefined} onChange={(e) => setReason(e.target.value)} data-autofocus />
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button type="button" variant="outline" className="h-11" onClick={() => setAsking(false)} disabled={saving}>
          Back
        </Button>
        <Button type="button" className="h-11" onClick={() => void confirm()} disabled={saving}>
          {saving ? "Reversing…" : "Yes, reverse it"}
        </Button>
      </div>
    </div>
  );
}

function EntryDetailView({ id, permissions, onOpen }: { id: string; permissions: AccountingPermissions; onOpen: (id: string) => void }) {
  const entry = useEntry(id);
  const [notice, setNotice] = useState<string | null>(null);
  if (entry.isPending) return <LoadingState label="Loading the entry" />;
  if (entry.isError) return <ErrorState title="Couldn’t load the entry" description={entry.error.message} onRetry={() => void entry.refetch()} />;
  const e = entry.data;
  const debits = sumDebits(e.lines);
  const credits = e.lines.reduce((sum, l) => sum + parseCents(l.credit), 0n);
  return (
    <div className="space-y-4">
      {notice ? <Done>{notice}</Done> : null}
      <dl className="text-sm">
        {[
          ["Date", formatDate(e.entryDate)],
          ["Period", `${e.periodMonth.toString().padStart(2, "0")}/${e.periodYear.toString()}`],
          ["Source", SOURCE_LABEL[e.source]],
          ["Description", e.description],
          ...(e.reference ? [["Reference", e.reference]] : []),
        ].map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4 border-b py-1.5 last:border-b-0">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right">{value}</dd>
          </div>
        ))}
      </dl>
      {e.reversesEntryId ? (
        <p className="text-sm">
          This entry reverses{" "}
          <button type="button" className="min-h-11 font-medium text-primary underline underline-offset-4" onClick={() => onOpen(e.reversesEntryId ?? "")}>
            another entry
          </button>
          .
        </p>
      ) : null}
      {e.reversedByEntryId ? (
        <p className="text-sm">
          Reversed by{" "}
          <button type="button" className="min-h-11 font-medium text-primary underline underline-offset-4" onClick={() => onOpen(e.reversedByEntryId ?? "")}>
            its reversing entry
          </button>
          .
        </p>
      ) : null}
      <table className="w-full text-sm">
        <caption className="sr-only">Entry lines</caption>
        <thead>
          <tr className="border-b-2 text-left">
            <th scope="col" className="py-1 font-medium">Account</th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">Debit</th>
            <th scope="col" className="py-1 text-right font-medium">Credit</th>
          </tr>
        </thead>
        <tbody>
          {e.lines.map((l) => (
            <tr key={l.id} className="border-b border-dashed last:border-b-0">
              <th scope="row" className="py-1 pr-3 text-left font-normal">
                <span className="mr-2 font-mono text-xs text-muted-foreground">{l.account.code}</span>
                {l.account.name}
                {l.memo ? <span className="block text-xs text-muted-foreground">{l.memo}</span> : null}
              </th>
              <td className="py-1 pr-3 text-right tabular-nums">{l.debit === "0" ? "" : formatKES(l.debit)}</td>
              <td className="py-1 text-right tabular-nums">{l.credit === "0" ? "" : formatKES(l.credit)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-4 border-double font-bold">
            <th scope="row" className="py-1.5 text-left">Totals</th>
            <td className="py-1.5 pr-3 text-right tabular-nums">{formatKES(debits)}</td>
            <td className="py-1.5 text-right tabular-nums">{formatKES(credits)}</td>
          </tr>
        </tfoot>
      </table>
      {permissions.canPost && !e.reversedByEntryId ? <Reverse entryId={e.id} onDone={(n) => setNotice(`Reversed: entry ${n} posts the opposite of every line.`)} /> : null}
    </div>
  );
}

function entryLabel(row: EntryRow): string {
  return `${row.entryNumber} · ${row.description}`;
}

export function JournalView({ permissions }: { permissions: AccountingPermissions }) {
  const ids = { from: useId(), to: useId() };
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const key = JSON.stringify({ from, to });
  const [paging, setPaging] = useState({ key, page: 0 });
  const page = paging.key === key ? paging.page : 0;
  const bad = from !== "" && to !== "" && from > to;
  const entries = useEntries({ ...(from ? { from } : {}), ...(to && !bad ? { to } : {}) }, page);
  const [open, setOpen] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  let list: ReactNode;
  if (bad) list = <p role="alert" className="text-sm text-destructive">The start date is after the end date.</p>;
  else if (entries.isPending) list = <LoadingState label="Loading the journal" lines={6} />;
  else if (entries.isError) list = <ErrorState title="Couldn’t load the journal" description={entries.error.message} onRetry={() => void entries.refetch()} />;
  else if (entries.data.data.length === 0) list = <EmptyState title="No entries" description={from || to ? "Nothing was posted in these dates." : "Postings appear here as the business trades."} />;
  else {
    const total = entries.data.pagination.total;
    const lastPage = Math.max(0, Math.ceil(total / ENTRIES_PAGE) - 1);
    list = (
      <>
        <ul aria-label="Journal entries" className="space-y-2">
          {entries.data.data.map((row) => (
            <li key={row.id}>
              <button type="button" onClick={() => setOpen(row.id)} aria-label={entryLabel(row)} className="flex min-h-11 w-full flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="min-w-0">
                  <span className="font-mono text-xs font-medium">{row.entryNumber}</span> <span className="font-medium">{row.description}</span>
                  <span className="block text-xs text-muted-foreground">
                    {formatDate(toBusinessDate(row.entryDate))} · {SOURCE_LABEL[row.source]}
                    {row.reversedByEntryId ? " · reversed" : ""}
                    {row.reversesEntryId ? " · a reversal" : ""}
                  </span>
                </span>
                <span className="tabular-nums">KES {formatKES(sumDebits(row.lines))}</span>
              </button>
            </li>
          ))}
        </ul>
        <nav aria-label="Journal pages" className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground" aria-live="polite">{`${(page * ENTRIES_PAGE + 1).toString()}–${Math.min(total, (page + 1) * ENTRIES_PAGE).toString()} of ${total.toString()} entries`}</p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="h-11" disabled={page === 0} onClick={() => setPaging({ key, page: page - 1 })}>
              Newer
            </Button>
            <Button type="button" variant="outline" className="h-11" disabled={page >= lastPage} onClick={() => setPaging({ key, page: page + 1 })}>
              Older
            </Button>
          </div>
        </nav>
      </>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField id={ids.from} label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <TextField id={ids.to} label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        {permissions.canPost ? (
          <Button type="button" className="h-11" onClick={() => setPosting(true)}>
            <Plus aria-hidden /> Post a journal entry
          </Button>
        ) : null}
      </div>
      {notice ? <Done>{notice}</Done> : null}
      {list}
      {open ? (
        <Sheet key={open} title="Journal entry" onClose={() => setOpen(null)} wide>
          <EntryDetailView id={open} permissions={permissions} onOpen={setOpen} />
        </Sheet>
      ) : null}
      {posting ? (
        <Sheet title="Post a journal entry" onClose={() => setPosting(false)} wide>
          <EntryForm
            onPosted={(e) => {
              setPosting(false);
              setNotice(`Entry ${e.entryNumber} posted.`);
              setOpen(e.id);
            }}
          />
        </Sheet>
      ) : null}
    </div>
  );
}
