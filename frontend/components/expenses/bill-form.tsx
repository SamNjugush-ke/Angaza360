"use client";

import { Trash2 } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { FormAlert, TextField } from "@/components/auth/form-bits";
import { quantityProblem, SelectField, shillingsProblem } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { businessToday, toBusinessDate } from "@/lib/datetime";
import { useSuppliers } from "@/lib/inventory/inventory";
import { centsToAmount, parseMajorToCents } from "@/lib/money";
import { billLineAccounts, createBill, updateBill, useAccounts, useInvalidatePayables, type Bill, type BillLineBody, type PayablesPermissions } from "@/lib/payables/payables";
import { displayQuantity, isQuantity, toMilli } from "@/lib/pos/quantity";
import { poName, usePurchaseOrders } from "@/lib/procurement/procurement";

// Entering a supplier's invoice as a DRAFT bill — nothing is posted until it is checked and posted.
// A line either MATCHES goods received on a purchase order (posting clears what those goods accrued
// in GRNI, and any price difference goes to purchase price variance) or charges an account directly.
// The bill number is the SUPPLIER'S own, and the API refuses the same invoice twice.

interface DraftLine {
  key: string;
  kind: "PO_MATCH" | "EXPENSE";
  purchaseOrderLineId: string | null;
  label: string;
  accountCode: string;
  description: string;
  quantity: string;
  unitCost: string;
  vatRate: string;
}

let next = 0;
const key = () => {
  next += 1;
  return `b${next.toString()}`;
};

const RATE = /^\d{1,3}(\.\d{1,2})?$/;

export function BillForm({ bill, permissions, onSaved }: { bill: Bill | null; permissions: PayablesPermissions; onSaved: (bill: Bill) => void }) {
  const ids = { supplier: useId(), number: useId(), po: useId(), billDate: useId(), dueDate: useId(), notes: useId(), error: useId() };
  const invalidate = useInvalidatePayables();
  const suppliers = useSuppliers(permissions.canReadSuppliers && bill === null);
  const orders = usePurchaseOrders("");
  const accounts = useAccounts(true);
  const chargeable = billLineAccounts(accounts.data?.data ?? []);
  const [today] = useState(() => businessToday());
  const [supplierId, setSupplierId] = useState(bill?.supplierId ?? "");
  const [billNumber, setBillNumber] = useState(bill?.billNumber ?? "");
  const [poId, setPoId] = useState(bill?.poId ?? "");
  const [billDate, setBillDate] = useState(bill ? toBusinessDate(bill.billDate) : today);
  const [dueDate, setDueDate] = useState(bill ? toBusinessDate(bill.dueDate) : "");
  const [notes, setNotes] = useState(bill?.notes ?? "");
  const [lines, setLines] = useState<DraftLine[]>(
    () =>
      bill?.lines.map((l) => ({
        key: key(),
        kind: l.kind,
        purchaseOrderLineId: l.purchaseOrderLineId,
        label: l.sku ?? l.expenseAccountCode ?? "",
        accountCode: l.expenseAccountCode ?? "",
        description: l.description,
        quantity: displayQuantity(l.quantity),
        unitCost: l.unitCostNet !== null ? centsToAmount(l.unitCostNet) : isQuantity(l.quantity) && toMilli(l.quantity) === 1000n ? centsToAmount(l.lineNet) : "",
        vatRate: l.vatRate,
      })) ?? [],
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Who the bill can be from: the supplier list for the owner and manager; for the accountant (who
  // may not read it) the suppliers of the purchase orders they can read.
  const choices = permissions.canReadSuppliers
    ? (suppliers.data?.data ?? []).filter((s) => s.isActive || s.id === supplierId).map((s) => ({ id: s.id, name: s.name }))
    : [...new Map((orders.data?.data ?? []).map((o) => [o.supplierId, { id: o.supplierId, name: o.supplierName }])).values()];
  const received = (orders.data?.data ?? []).filter((o) => o.supplierId === supplierId && (o.status === "PARTIALLY_RECEIVED" || o.status === "RECEIVED" || o.status === "CLOSED"));
  const order = received.find((o) => o.id === poId) ?? (orders.data?.data ?? []).find((o) => o.id === poId);

  function choosePo(id: string) {
    setPoId(id);
    const chosen = received.find((o) => o.id === id);
    const kept = lines.filter((l) => l.kind === "EXPENSE");
    if (!chosen) {
      setLines(kept);
      return;
    }
    setLines([
      ...chosen.lines
        // Start at what was received but not yet billed (T-B-PO-LINE-BILLEDQTY), so a second bill on the
        // same order does not offer the already-billed goods again.
        .filter((l) => isQuantity(l.unbilledQty) && toMilli(l.unbilledQty) > 0n)
        .map((l) => ({ key: key(), kind: "PO_MATCH" as const, purchaseOrderLineId: l.id, label: `${l.productName} (${l.sku})`, accountCode: "", description: l.productName, quantity: displayQuantity(l.unbilledQty), unitCost: centsToAmount(l.unitCost), vatRate: "" })),
      ...kept,
    ]);
  }

  const update = (lineKey: string, change: Partial<DraftLine>) => setLines(lines.map((l) => (l.key === lineKey ? { ...l, ...change } : l)));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (!bill && supplierId === "") found.supplier = "Choose the supplier who sent the invoice.";
    if (!bill && billNumber.trim() === "") found.number = "Enter the supplier's invoice number.";
    if (dueDate !== "" && dueDate < billDate) found.dueDate = "The due date cannot be before the invoice date.";
    if (lines.length === 0) found.lines = "Add at least one line.";
    for (const l of lines) {
      const q = quantityProblem(l.quantity);
      if (q) found[`q-${l.key}`] = q;
      const c = shillingsProblem(l.unitCost);
      if (c) found[`c-${l.key}`] = c;
      if (l.vatRate.trim() !== "" && !RATE.test(l.vatRate.trim())) found[`v-${l.key}`] = "A percentage, e.g. 16 or 16.00.";
      if (l.kind === "EXPENSE" && l.accountCode === "") found[`a-${l.key}`] = "Choose the account it is charged to.";
      if (l.description.trim() === "") found[`d-${l.key}`] = "Say what this line is for.";
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const body: BillLineBody[] = lines.map((l) => ({
      description: l.description.trim(),
      quantity: l.quantity.trim(),
      unitCost: centsToAmount(parseMajorToCents(l.unitCost)),
      ...(l.vatRate.trim() ? { vatRate: l.vatRate.trim() } : {}),
      ...(l.kind === "PO_MATCH" && l.purchaseOrderLineId ? { purchaseOrderLineId: l.purchaseOrderLineId } : { expenseAccountCode: l.accountCode }),
    }));
    setSaving(true);
    setError(null);
    try {
      const saved = bill
        ? await updateBill(bill.id, { billDate, ...(dueDate ? { dueDate } : {}), notes: notes.trim() === "" ? null : notes.trim(), lines: body })
        : await createBill({ supplierId, billNumber: billNumber.trim(), billDate, ...(poId ? { poId } : {}), ...(dueDate ? { dueDate } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}), lines: body });
      await invalidate();
      onSaved(saved);
    } catch (failure) {
      setError(failure instanceof ApiHttpError ? failure.message : "The bill could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="space-y-4">
      {error ? <FormAlert id={ids.error}>{error}</FormAlert> : null}
      {bill ? (
        <p className="text-sm">
          <span className="font-medium">{bill.supplierName}</span> · invoice {bill.billNumber}
          {bill.poNumber !== null ? ` · against PO ${bill.poNumber.toString().padStart(4, "0")}` : ""}
        </p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <SelectField
                id={ids.supplier}
                label="Supplier"
                value={supplierId}
                onChange={(v) => {
                  setSupplierId(v);
                  choosePo("");
                }}
                hint={permissions.canReadSuppliers ? undefined : "Suppliers you have purchase orders with."}
              >
                <option value="">Choose a supplier</option>
                {choices.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </SelectField>
              {errors.supplier ? <p className="text-sm text-destructive">{errors.supplier}</p> : null}
            </div>
            <TextField id={ids.number} label="Supplier's invoice number" autoComplete="off" value={billNumber} error={errors.number} onChange={(e) => setBillNumber(e.target.value)} />
          </div>
          {supplierId !== "" ? (
            <SelectField id={ids.po} label="Against a purchase order" value={poId} onChange={choosePo} hint="Received goods on the order are matched, and posting clears what they accrued.">
              <option value="">No purchase order — charge accounts directly</option>
              {received.map((o) => (
                <option key={o.id} value={o.id}>
                  {poName(o)} · {o.status === "PARTIALLY_RECEIVED" ? "partly received" : "received"}
                </option>
              ))}
            </SelectField>
          ) : null}
        </>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField id={ids.billDate} label="Invoice date" type="date" max={today} value={billDate} onChange={(e) => setBillDate(e.target.value)} />
        <TextField id={ids.dueDate} label="Due date" optional hint="Left blank, it follows the supplier's payment terms." type="date" value={dueDate} error={errors.dueDate} onChange={(e) => setDueDate(e.target.value)} />
      </div>

      <fieldset className="space-y-3">
        <legend className="font-medium">Lines</legend>
        {order ? <p className="text-sm text-muted-foreground">Quantities start at what {poName(order)} received. Enter what this invoice bills; the server refuses billing more than was received and not yet billed.</p> : null}
        <ul aria-label="Bill lines" className="space-y-2">
          {lines.map((l) => (
            <li key={l.key} className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium">{l.kind === "PO_MATCH" ? l.label : "Charged to an account"}</p>
                <button
                  type="button"
                  onClick={() => setLines(lines.filter((x) => x.key !== l.key))}
                  aria-label={`Remove ${l.kind === "PO_MATCH" ? l.label : "this line"}`}
                  className="flex size-11 items-center justify-center rounded-md text-destructive hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Trash2 className="size-4" aria-hidden />
                </button>
              </div>
              {l.kind === "EXPENSE" ? (
                <TextField id={`bd-${l.key}`} label="What it is" autoComplete="off" value={l.description} error={errors[`d-${l.key}`]} onChange={(e) => update(l.key, { description: e.target.value })} />
              ) : null}
              {l.kind === "EXPENSE" ? (
                <div className="space-y-1">
                  <SelectField id={`acct-${l.key}`} label="Account" value={l.accountCode} onChange={(v) => update(l.key, { accountCode: v })}>
                    <option value="">Choose an account</option>
                    {chargeable.map((a) => (
                      <option key={a.code} value={a.code}>
                        {a.code} {a.name}
                      </option>
                    ))}
                  </SelectField>
                  {errors[`a-${l.key}`] ? <p className="text-sm text-destructive">{errors[`a-${l.key}`]}</p> : null}
                </div>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-3">
                <TextField id={`bq-${l.key}`} label={`${l.kind === "PO_MATCH" ? l.label : "Line"} quantity`} inputMode="decimal" autoComplete="off" value={l.quantity} error={errors[`q-${l.key}`]} onChange={(e) => update(l.key, { quantity: e.target.value })} />
                <TextField id={`bc-${l.key}`} label={`${l.kind === "PO_MATCH" ? l.label : "Line"} cost per unit (KES)`} inputMode="decimal" autoComplete="off" value={l.unitCost} error={errors[`c-${l.key}`]} onChange={(e) => update(l.key, { unitCost: e.target.value })} />
                <TextField id={`bv-${l.key}`} label={`${l.kind === "PO_MATCH" ? l.label : "Line"} VAT %`} optional hint="Blank uses the standard rate." inputMode="decimal" autoComplete="off" value={l.vatRate} error={errors[`v-${l.key}`]} onChange={(e) => update(l.key, { vatRate: e.target.value })} />
              </div>
            </li>
          ))}
        </ul>
        {errors.lines ? (
          <p role="alert" className="text-sm text-destructive">
            {errors.lines}
          </p>
        ) : null}
        <Button type="button" variant="outline" className="h-11" onClick={() => setLines([...lines, { key: key(), kind: "EXPENSE", purchaseOrderLineId: null, label: "", accountCode: "", description: "", quantity: "1", unitCost: "", vatRate: "" }])}>
          Add a line charged to an account
        </Button>
        <p className="text-xs text-muted-foreground">Cost per unit is net of VAT if the business is VAT-registered, the whole invoiced amount if not.</p>
      </fieldset>
      <TextField id={ids.notes} label="Notes" optional autoComplete="off" value={notes} onChange={(e) => setNotes(e.target.value)} />
      <Button type="submit" className="h-11" disabled={saving}>
        {saving ? "Saving…" : bill ? "Save the draft" : "Save as draft"}
      </Button>
    </form>
  );
}
