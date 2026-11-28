"use client";

import { Plus } from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { FormAlert, TextField } from "@/components/auth/form-bits";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { Done, SelectField, shillingsProblem } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { businessToday, formatDate } from "@/lib/datetime";
import { centsToAmount, formatKES, parseMajorToCents } from "@/lib/money";
import { expenseCategories, METHOD_LABEL, recordExpense, useAccounts, useExpenses, useInvalidatePayables, voidExpense, type Expense, type ExpenseMethod } from "@/lib/payables/payables";
import { cn } from "@/lib/utils";

// Expenses: costs PAID NOW (cash, M-Pesa or bank) — rent, fuel, airtime. Each posts one entry
// (Dr the category, Cr where the money left) the moment it is recorded. Something bought on credit
// is a supplier bill instead. A mistake is VOIDED with a reason (a reversing entry), never edited.

const METHODS: readonly ExpenseMethod[] = ["CASH", "MPESA", "BANK"];

function ExpenseForm({ onSaved }: { onSaved: (expense: Expense) => void }) {
  const ids = { date: useId(), category: useId(), payee: useId(), description: useId(), method: useId(), amount: useId(), reference: useId(), error: useId() };
  const accounts = useAccounts(true);
  const categories = expenseCategories(accounts.data?.data ?? []);
  const invalidate = useInvalidatePayables();
  const [today] = useState(() => businessToday());
  const [expenseDate, setExpenseDate] = useState(today);
  const [category, setCategory] = useState("");
  const [payee, setPayee] = useState("");
  const [description, setDescription] = useState("");
  const [method, setMethod] = useState<ExpenseMethod>("CASH");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (category === "") found.category = "Choose what the money was spent on.";
    if (description.trim() === "") found.description = "Say what it was for.";
    const problem = shillingsProblem(amount, { allowZero: false });
    if (problem) found.amount = problem;
    if (expenseDate > today) found.date = "An expense cannot be dated in the future.";
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await recordExpense({
        expenseDate,
        category,
        description: description.trim(),
        paymentMethod: method,
        amount: centsToAmount(parseMajorToCents(amount)),
        ...(payee.trim() ? { payee: payee.trim() } : {}),
        ...(reference.trim() ? { reference: reference.trim() } : {}),
      });
      await invalidate();
      onSaved(saved);
    } catch (failure) {
      setError(failure instanceof ApiHttpError ? failure.message : "The expense could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="space-y-4">
      {error ? <FormAlert id={ids.error}>{error}</FormAlert> : null}
      <p className="text-sm text-muted-foreground">For costs already paid. Something bought on credit is a supplier bill.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <SelectField id={ids.category} label="Category" value={category} onChange={setCategory}>
            <option value="">Choose a category</option>
            {categories.map((a) => (
              <option key={a.code} value={a.code}>
                {a.name}
              </option>
            ))}
          </SelectField>
          {errors.category ? <p className="text-sm text-destructive">{errors.category}</p> : null}
        </div>
        <TextField id={ids.date} label="Date paid" type="date" max={today} value={expenseDate} error={errors.date} onChange={(e) => setExpenseDate(e.target.value)} />
      </div>
      <TextField id={ids.description} label="What it was for" autoComplete="off" value={description} error={errors.description} onChange={(e) => setDescription(e.target.value)} />
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField id={ids.amount} label="Amount (KES)" inputMode="decimal" autoComplete="off" value={amount} error={errors.amount} onChange={(e) => setAmount(e.target.value)} />
        <SelectField id={ids.method} label="Paid by" value={method} onChange={(v) => setMethod(v as ExpenseMethod)}>
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {METHOD_LABEL[m]}
            </option>
          ))}
        </SelectField>
        <TextField id={ids.payee} label="Paid to" optional autoComplete="off" value={payee} onChange={(e) => setPayee(e.target.value)} />
      </div>
      <TextField id={ids.reference} label="Reference" optional placeholder="Receipt or M-Pesa code" autoComplete="off" value={reference} onChange={(e) => setReference(e.target.value)} />
      <Button type="submit" className="h-11" disabled={saving}>
        {saving ? "Saving…" : "Record expense"}
      </Button>
    </form>
  );
}

function VoidExpense({ expense, onDone }: { expense: Expense; onDone: (expense: Expense) => void }) {
  const ids = { reason: useId(), title: useId() };
  const invalidate = useInvalidatePayables();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (!asking) {
    return (
      <Button type="button" variant="outline" className="h-11" onClick={() => setAsking(true)} aria-label={`Void ${expense.description}`}>
        Void
      </Button>
    );
  }
  async function confirm() {
    if (reason.trim() === "") {
      setProblem("Give a reason — it is kept with the expense.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const voided = await voidExpense(expense.id, reason.trim());
      await invalidate();
      onDone(voided);
    } catch (failure) {
      setError(failure instanceof ApiHttpError ? failure.message : "The expense could not be voided. Please try again.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div role="alertdialog" aria-labelledby={ids.title} className="w-full space-y-2 rounded-md border border-destructive/40 p-3">
      <p id={ids.title} className="font-medium">
        Void “{expense.description}” (KES {formatKES(expense.amountCents)})?
      </p>
      <p className="text-sm">A reversing entry takes it back out of the books; the original stays on record.</p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <TextField id={ids.reason} label="Reason for the void" autoComplete="off" value={reason} error={problem ?? undefined} onChange={(e) => setReason(e.target.value)} data-autofocus />
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button type="button" variant="outline" className="h-11" onClick={() => setAsking(false)} disabled={saving}>
          Back
        </Button>
        <Button type="button" variant="destructive" className="h-11" onClick={() => void confirm()} disabled={saving}>
          {saving ? "Voiding…" : "Yes, void it"}
        </Button>
      </div>
    </div>
  );
}

export function ExpensesView({ canRecord }: { canRecord: boolean }) {
  const ids = { voided: useId() };
  const [includeVoided, setIncludeVoided] = useState(false);
  const expenses = useExpenses(includeVoided);
  const accounts = useAccounts(true);
  const nameOf = (code: string) => accounts.data?.data.find((a) => a.code === code)?.name ?? code;
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<ReactNode>(null);

  let list: ReactNode;
  if (expenses.isPending) list = <LoadingState label="Loading expenses" lines={4} />;
  else if (expenses.isError) list = <ErrorState title="Couldn’t load expenses" description={expenses.error.message} onRetry={() => void expenses.refetch()} />;
  else if (expenses.data.data.length === 0) list = <EmptyState title="No expenses recorded" description={canRecord ? "Record rent, fuel, airtime and other costs as they are paid." : "Paid expenses appear here."} />;
  else
    list = (
      <ul aria-label="Expenses" className="space-y-2">
        {expenses.data.data.map((e) => (
          <li key={e.id} className={cn("flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3 text-sm", e.isVoided && "opacity-70")}>
            <div className="min-w-0 space-y-0.5">
              <p className="font-medium">
                {e.description}
                {e.isVoided ? <span className="ml-2 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-xs">Voided</span> : null}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatDate(e.expenseDate)} · {nameOf(e.category)} · {METHOD_LABEL[e.paymentMethod]}
                {e.payee ? ` · to ${e.payee}` : ""}
                {e.reference ? ` · ${e.reference}` : ""}
                {e.isVoided && e.voidReason ? ` · voided: ${e.voidReason}` : ""}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span className={cn("font-medium tabular-nums", e.isVoided && "line-through")}>KES {formatKES(e.amountCents)}</span>
              {canRecord && !e.isVoided ? <VoidExpense expense={e} onDone={(v) => setNotice(`“${v.description}” was voided.`)} /> : null}
            </div>
          </li>
        ))}
      </ul>
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label htmlFor={ids.voided} className="flex min-h-11 items-center gap-3 text-sm">
          <input id={ids.voided} type="checkbox" className="size-5" checked={includeVoided} onChange={(e) => setIncludeVoided(e.target.checked)} />
          Show voided expenses
        </label>
        {canRecord ? (
          <Button type="button" className="h-11" onClick={() => setAdding(true)}>
            <Plus aria-hidden /> Record expense
          </Button>
        ) : null}
      </div>
      {notice ? <Done>{notice}</Done> : null}
      {list}
      {adding ? (
        <Sheet title="Record an expense" onClose={() => setAdding(false)}>
          <ExpenseForm
            onSaved={(saved) => {
              setNotice(`Recorded “${saved.description}”: KES ${formatKES(saved.amountCents)} paid by ${METHOD_LABEL[saved.paymentMethod]}.`);
              setAdding(false);
            }}
          />
        </Sheet>
      ) : null}
    </div>
  );
}
