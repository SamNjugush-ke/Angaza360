"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { FormAlert, TextField } from "@/components/auth/form-bits";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { createSupplier, inventoryKeys, updateSupplier, useSuppliers, type Supplier } from "@/lib/inventory/inventory";
import { cn } from "@/lib/utils";

// Suppliers — who the business buys from. The owner and manager keep the list (the API's guard);
// a retired supplier is marked inactive rather than deleted, because orders and bills point at it.

const BADGE = "inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium";

export function SupplierForm({ supplier, onSaved }: { supplier: Supplier | null; onSaved: (saved: Supplier) => void }) {
  const ids = { name: useId(), contact: useId(), phone: useId(), email: useId(), pin: useId(), terms: useId(), lead: useId(), active: useId(), error: useId() };
  const [name, setName] = useState(supplier?.name ?? "");
  const [contactName, setContactName] = useState(supplier?.contactName ?? "");
  const [phone, setPhone] = useState(supplier?.phone ?? "");
  const [email, setEmail] = useState(supplier?.email ?? "");
  const [kraPin, setKraPin] = useState(supplier?.kraPin ?? "");
  const [paymentTerms, setPaymentTerms] = useState(supplier?.paymentTerms ?? "");
  const [lead, setLead] = useState(supplier?.leadTimeDays?.toString() ?? "");
  const [active, setActive] = useState(supplier?.isActive ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (name.trim() === "") found.name = "Give the supplier a name.";
    if (lead.trim() !== "" && !/^\d+$/.test(lead.trim())) found.lead = "Enter whole days, e.g. 3.";
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const leadTimeDays = lead.trim() === "" ? null : Number.parseInt(lead.trim(), 10);
    setSaving(true);
    setError(null);
    try {
      if (supplier) {
        onSaved(
          await updateSupplier(supplier.id, {
            name: name.trim(),
            contactName: contactName.trim(),
            phone: phone.trim(),
            email: email.trim(),
            kraPin: kraPin.trim(),
            paymentTerms: paymentTerms.trim(),
            leadTimeDays,
            isActive: active,
          }),
        );
      } else {
        const optional = { contactName, phone, email, kraPin, paymentTerms };
        onSaved(
          await createSupplier({
            name: name.trim(),
            ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, v.trim()])),
            ...(leadTimeDays === null ? {} : { leadTimeDays }),
          }),
        );
      }
    } catch (failure) {
      setError(failure instanceof ApiHttpError ? failure.message : "The supplier could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="space-y-4">
      {error ? <FormAlert id={ids.error}>{error}</FormAlert> : null}
      <TextField id={ids.name} label="Supplier name" autoComplete="off" value={name} error={errors.name} onChange={(e) => setName(e.target.value)} data-autofocus />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField id={ids.contact} label="Contact person" optional autoComplete="off" value={contactName} onChange={(e) => setContactName(e.target.value)} />
        <TextField id={ids.phone} label="Phone" optional type="tel" autoComplete="off" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <TextField id={ids.email} label="Email" optional type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
        <TextField id={ids.pin} label="KRA PIN" optional autoComplete="off" value={kraPin} onChange={(e) => setKraPin(e.target.value.toUpperCase())} />
        <TextField id={ids.terms} label="Payment terms" optional placeholder="e.g. Net 30" autoComplete="off" value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} />
        <TextField id={ids.lead} label="Lead time (days)" optional inputMode="numeric" autoComplete="off" value={lead} error={errors.lead} onChange={(e) => setLead(e.target.value)} />
      </div>
      {supplier ? (
        <label htmlFor={ids.active} className="flex min-h-11 items-center gap-3 text-sm">
          <input id={ids.active} type="checkbox" className="size-5" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active — offered on new orders
        </label>
      ) : null}
      <Button type="submit" className="h-11" disabled={saving}>
        {saving ? "Saving…" : supplier ? "Save changes" : "Add supplier"}
      </Button>
    </form>
  );
}

export function SuppliersView() {
  const client = useQueryClient();
  const suppliers = useSuppliers(true);
  const [panel, setPanel] = useState<{ supplier: Supplier | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  let body: ReactNode;
  if (suppliers.isPending) body = <LoadingState label="Loading suppliers" lines={4} />;
  else if (suppliers.isError) body = <ErrorState title="Couldn’t load suppliers" description={suppliers.error.message} onRetry={() => void suppliers.refetch()} />;
  else if (suppliers.data.data.length === 0) body = <EmptyState title="No suppliers yet" description="Add the businesses you buy from, then raise purchase orders to them." />;
  else
    body = (
      <ul aria-label="Suppliers" className="space-y-2">
        {suppliers.data.data.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
            <div className="min-w-0 space-y-1">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{s.name}</span>
                <span className={cn(BADGE, s.isActive ? "border-emerald-700/40 bg-emerald-700/10" : "border-destructive/40 bg-destructive/10")}>{s.isActive ? "Active" : "Inactive"}</span>
              </p>
              <p className="text-sm text-muted-foreground">
                {[s.contactName, s.phone, s.paymentTerms, s.leadTimeDays === null ? null : `${s.leadTimeDays.toString()} days lead time`].filter(Boolean).join(" · ") || "No contact details yet"}
              </p>
            </div>
            <Button type="button" variant="outline" className="h-11" onClick={() => setPanel({ supplier: s })} aria-label={`Edit ${s.name}`}>
              Edit
            </Button>
          </li>
        ))}
      </ul>
    );

  return (
    <div className="space-y-4">
      <Button type="button" className="h-11" onClick={() => setPanel({ supplier: null })}>
        <Plus aria-hidden /> Add supplier
      </Button>
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
      {body}
      {panel ? (
        <Sheet title={panel.supplier ? `Edit ${panel.supplier.name}` : "Add a supplier"} onClose={() => setPanel(null)}>
          <SupplierForm
            supplier={panel.supplier}
            onSaved={(saved) => {
              void client.invalidateQueries({ queryKey: inventoryKeys.suppliers() });
              setNotice(`${saved.name} ${panel.supplier ? "was saved" : "was added"}.`);
              setPanel(null);
            }}
          />
        </Sheet>
      ) : null}
    </div>
  );
}
