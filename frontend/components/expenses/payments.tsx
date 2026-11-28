"use client";

import { Plus } from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { FormAlert, TextField } from "@/components/auth/form-bits";
import { AllocationEditor, type AllocationItem } from "@/components/money/shared";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { Done, SelectField, shillingsProblem } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { allocationsToBody, checkAllocation } from "@/lib/allocation";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { businessToday, formatDate } from "@/lib/datetime";
import { centsToAmount, formatKES, parseCents, parseMajorToCents } from "@/lib/money";
import { isOpenBill, METHOD_LABEL, payBills, useBills, useInvalidatePayables, usePayments, type Payment, type PaymentMethod } from "@/lib/payables/payables";
import { owedOn } from "./bills";

// Paying a supplier: money out against their posted, unpaid bills. Every shilling is allocated to a
// bill — the API keeps no prepayment balance — so the form proposes an oldest-due-first split the
// person can change, and saves only when it adds up to the payment exactly.

const METHODS: readonly PaymentMethod[] = ["BANK", "MPESA", "CASH"];

function typed(value: string): bigint | null {
  try {
    return value.trim() === "" ? null : parseMajorToCents(value);
  } catch {
    return null;
  }
}

export function PaymentForm({ supplier: preset }: { supplier?: { id: string; name: string } }) {
  const ids = { supplier: useId(), date: useId(), method: useId(), amount: useId(), reference: useId(), notes: useId(), error: useId() };
  const invalidate = useInvalidatePayables();
  const [today] = useState(() => businessToday());
  const all = useBills("", "", preset === undefined);
  const [supplierId, setSupplierId] = useState(preset?.id ?? "");
  const bills = useBills("", supplierId, supplierId !== "");
  const [paymentDate, setPaymentDate] = useState(today);
  const [method, setMethod] = useState<PaymentMethod>("BANK");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [shares, setShares] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<Payment | null>(null);

  const suppliers = [...new Map((all.data?.data ?? []).filter((b) => isOpenBill(b.status)).map((b) => [b.supplierId, b.supplierName])).entries()];
  const open = (bills.data?.data ?? []).filter((b) => isOpenBill(b.status)).sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
  const items: AllocationItem[] = open.map((b) => {
    const share = typed(shares[b.id] ?? "") ?? 0n;
    const owed = parseCents(owedOn(b));
    const effect = share <= 0n ? "" : share === owed ? " · this settles it" : share < owed ? ` · leaves KES ${formatKES(owed - share)}` : "";
    return { id: b.id, outstanding: owedOn(b), label: `Bill ${b.billNumber}`, detail: `Due ${formatDate(b.dueDate)} · owes KES ${formatKES(owed)} of ${formatKES(b.total)}${effect}` };
  });
  const amountCents = typed(amount);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (supplierId === "") found.supplier = "Choose the supplier you are paying.";
    const problem = shillingsProblem(amount, { allowZero: false });
    if (problem) found.amount = problem;
    if (paymentDate > today) found.date = "A payment cannot be dated in the future.";
    if (!problem && supplierId !== "" && !checkAllocation(items, shares, amountCents).ok) found.allocation = "Allocate the whole payment across the bills below — no more than each owes.";
    setErrors(found);
    if (Object.keys(found).length > 0 || amountCents === null) return;
    setSaving(true);
    setError(null);
    try {
      const payment = await payBills({
        supplierId,
        paymentDate,
        method,
        amount: centsToAmount(amountCents),
        ...(reference.trim() ? { reference: reference.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        allocations: allocationsToBody(items, shares, "billId"),
      });
      setSaved(payment);
      await invalidate();
    } catch (failure) {
      setError(failure instanceof ApiHttpError ? failure.message : "The payment could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (saved) {
    return (
      <Done>
        Payment {saved.paymentNumber.toString()} recorded: KES {formatKES(saved.amount)} to {saved.supplierName} by {METHOD_LABEL[saved.method]}, against {saved.allocations.map((a) => `bill ${a.billNumber} (KES ${formatKES(a.amount)})`).join(", ")}.
      </Done>
    );
  }

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="space-y-4">
      {error ? <FormAlert id={ids.error}>{error}</FormAlert> : null}
      {preset === undefined ? (
        <div className="space-y-1">
          <SelectField
            id={ids.supplier}
            label="Supplier"
            value={supplierId}
            onChange={(v) => {
              setSupplierId(v);
              setShares({});
            }}
            hint="Suppliers with posted bills still to pay."
          >
            <option value="">Choose a supplier</option>
            {suppliers.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </SelectField>
          {errors.supplier ? <p className="text-sm text-destructive">{errors.supplier}</p> : null}
        </div>
      ) : (
        <p className="text-sm">
          Paying <span className="font-medium">{preset.name}</span>
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField id={ids.amount} label="Amount paid (KES)" inputMode="decimal" autoComplete="off" value={amount} error={errors.amount} onChange={(e) => setAmount(e.target.value)} />
        <SelectField id={ids.method} label="Paid by" value={method} onChange={(v) => setMethod(v as PaymentMethod)}>
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {METHOD_LABEL[m]}
            </option>
          ))}
        </SelectField>
        <TextField id={ids.date} label="Date paid" type="date" max={today} value={paymentDate} error={errors.date} onChange={(e) => setPaymentDate(e.target.value)} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField id={ids.reference} label="Reference" optional placeholder="Transfer ref or M-Pesa code" autoComplete="off" value={reference} onChange={(e) => setReference(e.target.value)} />
        <TextField id={ids.notes} label="Notes" optional autoComplete="off" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      {supplierId === "" ? null : bills.isPending ? (
        <LoadingState label="Loading their bills" lines={2} />
      ) : bills.isError ? (
        <ErrorState title="Couldn’t load their bills" description={bills.error.message} onRetry={() => void bills.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title="Nothing to pay" description="This supplier has no posted bills still owed." />
      ) : (
        <AllocationEditor items={items} shares={shares} onChange={setShares} amountCents={amountCents} legend="Against which bills" />
      )}
      {errors.allocation ? (
        <p role="alert" className="text-sm text-destructive">
          {errors.allocation}
        </p>
      ) : null}
      <Button type="submit" className="h-11" disabled={saving || (supplierId !== "" && bills.isSuccess && items.length === 0)}>
        {saving ? "Saving…" : "Record payment"}
      </Button>
    </form>
  );
}

export function PaymentsView({ canPay }: { canPay: boolean }) {
  const payments = usePayments();
  const [paying, setPaying] = useState(false);
  let list: ReactNode;
  if (payments.isPending) list = <LoadingState label="Loading payments" lines={4} />;
  else if (payments.isError) list = <ErrorState title="Couldn’t load payments" description={payments.error.message} onRetry={() => void payments.refetch()} />;
  else if (payments.data.data.length === 0) list = <EmptyState title="No supplier payments yet" description="Payments against posted bills appear here." />;
  else
    list = (
      <ul aria-label="Supplier payments" className="space-y-2">
        {payments.data.data.map((p) => (
          <li key={p.id} className="space-y-1 rounded-lg border p-3 text-sm">
            <p className="flex flex-wrap justify-between gap-3">
              <span className="font-medium">
                Payment {p.paymentNumber.toString()} · {p.supplierName}
              </span>
              <span className="tabular-nums">KES {formatKES(p.amount)}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {formatDate(p.paymentDate)} · {METHOD_LABEL[p.method]}
              {p.reference ? ` · ${p.reference}` : ""} · against {p.allocations.map((a) => `bill ${a.billNumber} (KES ${formatKES(a.amount)})`).join(", ")}
            </p>
          </li>
        ))}
      </ul>
    );
  return (
    <div className="space-y-4">
      {canPay ? (
        <Button type="button" className="h-11" onClick={() => setPaying(true)}>
          <Plus aria-hidden /> Pay a supplier
        </Button>
      ) : null}
      {list}
      {paying ? (
        <Sheet title="Pay a supplier" onClose={() => setPaying(false)} wide>
          <PaymentForm />
        </Sheet>
      ) : null}
    </div>
  );
}
