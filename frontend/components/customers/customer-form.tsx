"use client";

import { useId, useState, type FormEvent } from "react";
import { FormAlert, TextField } from "@/components/auth/form-bits";
import { shillingsProblem } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { centsToAmount, parseMajorToCents } from "@/lib/money";
import { createCustomer, updateCustomer, type Customer } from "@/lib/receivables/receivables";

// Adding or editing a customer. Anyone who keeps the directory may add one; only the owner or manager
// sets how much credit a customer may run up, or retires them (the API's guards).

export function CustomerForm({ customer, canSetCredit, onSaved }: { customer: Customer | null; canSetCredit: boolean; onSaved: (saved: Customer) => void }) {
  const ids = { name: useId(), phone: useId(), email: useId(), pin: useId(), limit: useId(), active: useId(), error: useId() };
  const [name, setName] = useState(customer?.name ?? "");
  const [phone, setPhone] = useState(customer?.phone ?? "");
  const [email, setEmail] = useState(customer?.email ?? "");
  const [kraPin, setKraPin] = useState(customer?.kraPin ?? "");
  const [limit, setLimit] = useState(customer ? centsToAmount(customer.creditLimit) : "");
  const [active, setActive] = useState(customer?.isActive ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (name.trim() === "") found.name = "Give the customer a name.";
    if (canSetCredit && limit.trim() !== "") {
      const problem = shillingsProblem(limit);
      if (problem) found.limit = problem;
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const creditLimit = canSetCredit && limit.trim() !== "" ? { creditLimit: centsToAmount(parseMajorToCents(limit)) } : {};
    setSaving(true);
    setError(null);
    try {
      if (customer) {
        onSaved(await updateCustomer(customer.id, { name: name.trim(), phone: phone.trim(), email: email.trim(), kraPin: kraPin.trim(), ...creditLimit, isActive: active }));
      } else {
        const optional = Object.fromEntries(
          Object.entries({ phone, email, kraPin })
            .filter(([, v]) => v.trim() !== "")
            .map(([k, v]) => [k, v.trim()]),
        );
        onSaved(await createCustomer({ name: name.trim(), ...optional, ...creditLimit }));
      }
    } catch (failure) {
      setError(failure instanceof ApiHttpError ? failure.message : "The customer could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="space-y-4">
      {error ? <FormAlert id={ids.error}>{error}</FormAlert> : null}
      <TextField id={ids.name} label="Customer name" autoComplete="off" value={name} error={errors.name} onChange={(e) => setName(e.target.value)} data-autofocus />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField id={ids.phone} label="Phone" optional type="tel" autoComplete="off" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <TextField id={ids.email} label="Email" optional type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
        <TextField id={ids.pin} label="KRA PIN" optional autoComplete="off" value={kraPin} onChange={(e) => setKraPin(e.target.value.toUpperCase())} />
        {canSetCredit ? (
          <TextField id={ids.limit} label="Credit limit (KES)" optional hint="How much they may owe at once. 0 means cash only." inputMode="decimal" autoComplete="off" value={limit} error={errors.limit} onChange={(e) => setLimit(e.target.value)} />
        ) : null}
      </div>
      {customer && canSetCredit ? (
        <label htmlFor={ids.active} className="flex min-h-11 items-center gap-3 text-sm">
          <input id={ids.active} type="checkbox" className="size-5" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active — can be chosen at the till
        </label>
      ) : null}
      <Button type="submit" className="h-11" disabled={saving}>
        {saving ? "Saving…" : customer ? "Save changes" : "Add customer"}
      </Button>
    </form>
  );
}
