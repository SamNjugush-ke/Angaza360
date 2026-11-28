"use client";

import { useId, useState, type FormEvent } from "react";
import { FormAlert, TextField } from "@/components/auth/form-bits";
import { AllocationEditor, type AllocationItem } from "@/components/money/shared";
import { LoadingState, ErrorState, EmptyState } from "@/components/states/states";
import { Done, SelectField, shillingsProblem } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { allocationsToBody, checkAllocation } from "@/lib/allocation";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { businessToday, formatDate } from "@/lib/datetime";
import { centsToAmount, formatKES, parseCents, parseMajorToCents } from "@/lib/money";
import { METHOD_LABEL, recordReceipt, useArAging, useInvalidateReceivables, useOpen, type Receipt, type ReceiptMethod } from "@/lib/receivables/receivables";

// Recording money a customer paid against what they owe on credit. Every shilling goes to one of
// their open credit sales — the API keeps no "on account" balance — so the form proposes an
// oldest-first split the person can change, shows what each share clears, and only saves when the
// shares add up to the receipt exactly. The server re-checks all of it.

const METHODS: readonly ReceiptMethod[] = ["MPESA", "CASH", "BANK"];

function typed(value: string): bigint | null {
  try {
    return value.trim() === "" ? null : parseMajorToCents(value);
  } catch {
    return null;
  }
}

export function ReceiptForm({ customerId: preset, onDone }: { customerId?: string; onDone?: (receipt: Receipt) => void }) {
  const ids = { customer: useId(), date: useId(), method: useId(), amount: useId(), reference: useId(), notes: useId(), error: useId() };
  const invalidate = useInvalidateReceivables();
  const [today] = useState(() => businessToday());
  const owing = useArAging(today, preset === undefined);
  const [customerId, setCustomerId] = useState(preset ?? "");
  const open = useOpen(customerId, customerId !== "");
  const [receiptDate, setReceiptDate] = useState(today);
  const [method, setMethod] = useState<ReceiptMethod>("MPESA");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [shares, setShares] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<Receipt | null>(null);

  const sales = open.data?.data ?? [];
  const items: AllocationItem[] = sales.map((s) => {
    const share = typed(shares[s.saleId] ?? "") ?? 0n;
    const owed = parseCents(s.outstanding);
    const effect = share <= 0n ? "" : share === owed ? " · this clears it" : share < owed ? ` · leaves KES ${formatKES(owed - share)}` : "";
    return {
      id: s.saleId,
      outstanding: s.outstanding,
      label: s.saleNumber,
      detail: `Sold ${formatDate(s.saleDate)} · owes KES ${formatKES(s.outstanding)} of ${formatKES(s.creditTotal)} · ${s.daysOutstanding.toString()} days${effect}`,
    };
  });
  const amountCents = typed(amount);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (customerId === "") found.customer = "Choose the customer who paid.";
    const problem = shillingsProblem(amount, { allowZero: false });
    if (problem) found.amount = problem;
    if (receiptDate > today) found.date = "A receipt cannot be dated in the future.";
    if (!problem && !checkAllocation(items, shares, amountCents).ok) found.allocation = "Allocate the whole amount across the sales below — no more than each owes.";
    setErrors(found);
    if (Object.keys(found).length > 0 || amountCents === null) return;
    setSaving(true);
    setError(null);
    try {
      const receipt = await recordReceipt({
        customerId,
        receiptDate,
        method,
        amount: centsToAmount(amountCents),
        ...(reference.trim() ? { reference: reference.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        allocations: allocationsToBody(items, shares, "saleId"),
      });
      setSaved(receipt);
      await invalidate();
      onDone?.(receipt);
    } catch (failure) {
      setError(failure instanceof ApiHttpError ? failure.message : "The receipt could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (saved) {
    return (
      <Done>
        Receipt {saved.receiptNumber.toString()} recorded: KES {formatKES(saved.amount)} from {saved.customerName} by {METHOD_LABEL[saved.method]}, against{" "}
        {saved.allocations.map((a) => `${a.saleNumber} (KES ${formatKES(a.amount)})`).join(", ")}. Their balance is updated.
      </Done>
    );
  }

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="space-y-4">
      {error ? <FormAlert id={ids.error}>{error}</FormAlert> : null}
      {preset === undefined ? (
        <div className="space-y-1">
          <SelectField
            id={ids.customer}
            label="Customer"
            value={customerId}
            onChange={(v) => {
              setCustomerId(v);
              setShares({});
            }}
            hint="Customers who owe money on credit."
          >
            <option value="">Choose a customer</option>
            {(owing.data?.customers ?? []).map((c) => (
              <option key={c.customerId} value={c.customerId}>
                {c.customerName} — owes KES {formatKES(c.total)}
              </option>
            ))}
          </SelectField>
          {errors.customer ? <p className="text-sm text-destructive">{errors.customer}</p> : null}
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField id={ids.amount} label="Amount received (KES)" inputMode="decimal" autoComplete="off" value={amount} error={errors.amount} onChange={(e) => setAmount(e.target.value)} />
        <SelectField id={ids.method} label="Paid by" value={method} onChange={(v) => setMethod(v as ReceiptMethod)}>
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {METHOD_LABEL[m]}
            </option>
          ))}
        </SelectField>
        <TextField id={ids.date} label="Date received" type="date" max={today} value={receiptDate} error={errors.date} onChange={(e) => setReceiptDate(e.target.value)} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField id={ids.reference} label="Reference" optional placeholder="M-Pesa code, cheque or transfer ref" autoComplete="off" value={reference} onChange={(e) => setReference(e.target.value)} />
        <TextField id={ids.notes} label="Notes" optional autoComplete="off" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      {customerId === "" ? null : open.isPending ? (
        <LoadingState label="Loading what they owe" lines={2} />
      ) : open.isError ? (
        <ErrorState title="Couldn’t load what they owe" description={open.error.message} onRetry={() => void open.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title="Nothing owed" description="This customer has no open credit sales to receive against." />
      ) : (
        <AllocationEditor items={items} shares={shares} onChange={setShares} amountCents={amountCents} legend="Against which sales" />
      )}
      {errors.allocation ? (
        <p role="alert" className="text-sm text-destructive">
          {errors.allocation}
        </p>
      ) : null}
      <Button type="submit" className="h-11" disabled={saving || (customerId !== "" && open.isSuccess && items.length === 0)}>
        {saving ? "Saving…" : "Record receipt"}
      </Button>
    </form>
  );
}
