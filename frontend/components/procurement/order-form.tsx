"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { FormAlert, TextField } from "@/components/auth/form-bits";
import { ProductPicker, quantityProblem, SelectField, shillingsProblem, type PickedProduct } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { businessToday, toBusinessDate } from "@/lib/datetime";
import { inventoryKeys, useSuppliers } from "@/lib/inventory/inventory";
import { centsToAmount, parseMajorToCents } from "@/lib/money";
import { displayQuantity } from "@/lib/pos/quantity";
import { createPurchaseOrder, updatePurchaseOrder, type ProcurementPermissions, type PurchaseOrder } from "@/lib/procurement/procurement";
import { SupplierForm } from "./suppliers";

// Raising a purchase order, or correcting it while it is still a DRAFT: the supplier, the dates and
// the lines (product, quantity, cost per unit in shillings). A draft commits nothing — no stock, no
// ledger — until it is approved and goods arrive. Saving an edit REPLACES the line set (the API's
// rule), so the form always sends every line. Totals are the server's, shown once saved.

interface DraftLine {
  key: string;
  product: PickedProduct;
  quantity: string;
  unitCost: string;
}

let next = 0;
const key = () => {
  next += 1;
  return `l${next.toString()}`;
};

export function OrderForm({ order, permissions, onSaved }: { order: PurchaseOrder | null; permissions: ProcurementPermissions; onSaved: (order: PurchaseOrder) => void }) {
  const ids = { supplier: useId(), ordered: useId(), expected: useId(), notes: useId(), error: useId() };
  const client = useQueryClient();
  const suppliers = useSuppliers(permissions.canChangeSupplier);
  const [today] = useState(() => businessToday());
  const [supplierId, setSupplierId] = useState(order?.supplierId ?? "");
  const [addingSupplier, setAddingSupplier] = useState(false);
  const [orderDate, setOrderDate] = useState(order ? toBusinessDate(order.orderDate) : today);
  const [expectedDate, setExpectedDate] = useState(order?.expectedDate ? toBusinessDate(order.expectedDate) : "");
  const [notes, setNotes] = useState(order?.notes ?? "");
  const [lines, setLines] = useState<DraftLine[]>(
    () =>
      order?.lines.map((l) => ({
        key: key(),
        product: { id: l.productId, name: l.productName, sku: l.sku, unitOfMeasure: "", costPrice: l.unitCost },
        quantity: displayQuantity(l.orderedQty),
        unitCost: centsToAmount(l.unitCost),
      })) ?? [],
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function add(product: PickedProduct | null) {
    if (!product) return;
    if (lines.some((l) => l.product.id === product.id)) {
      setErrors({ ...errors, add: `${product.name} is already on this order — change its quantity instead.` });
      return;
    }
    setErrors({ ...errors, add: "" });
    setLines([...lines, { key: key(), product, quantity: "", unitCost: centsToAmount(product.costPrice) }]);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (supplierId === "") found.supplier = "Choose the supplier.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(orderDate)) found.orderDate = "Enter the order date.";
    if (expectedDate !== "" && expectedDate < orderDate) found.expectedDate = "Delivery cannot be expected before the order date.";
    if (lines.length === 0) found.add = "Add at least one product.";
    for (const line of lines) {
      const q = quantityProblem(line.quantity);
      if (q) found[`q-${line.key}`] = q;
      const c = shillingsProblem(line.unitCost);
      if (c) found[`c-${line.key}`] = c;
    }
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;
    const body = {
      orderDate,
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      lines: lines.map((l) => ({ productId: l.product.id, quantity: l.quantity.trim(), unitCost: centsToAmount(parseMajorToCents(l.unitCost)) })),
    };
    setSaving(true);
    setError(null);
    try {
      if (order) {
        onSaved(
          await updatePurchaseOrder(order.id, {
            ...body,
            ...(permissions.canChangeSupplier ? { supplierId } : {}),
            expectedDate: expectedDate === "" ? null : expectedDate,
            notes: notes.trim() === "" ? null : notes.trim(),
          }),
        );
      } else {
        onSaved(await createPurchaseOrder({ ...body, supplierId, ...(expectedDate ? { expectedDate } : {}) }));
      }
    } catch (failure) {
      setError(failure instanceof ApiHttpError ? failure.message : "The order could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const active = (suppliers.data?.data ?? []).filter((s) => s.isActive || s.id === supplierId);

  return (
    <div className="space-y-4">
      {addingSupplier ? (
        <section aria-label="New supplier" className="space-y-3 rounded-lg border p-3">
          <p className="font-medium">New supplier</p>
          <SupplierForm
            supplier={null}
            onSaved={(saved) => {
              void client.invalidateQueries({ queryKey: inventoryKeys.suppliers() });
              setSupplierId(saved.id);
              setAddingSupplier(false);
            }}
          />
          <Button type="button" variant="ghost" className="h-11" onClick={() => setAddingSupplier(false)}>
            Back to the order
          </Button>
        </section>
      ) : null}
      <form noValidate onSubmit={(e) => void submit(e)} className={addingSupplier ? "hidden" : "space-y-4"}>
        {error ? <FormAlert id={ids.error}>{error}</FormAlert> : null}
        {permissions.canChangeSupplier ? (
          <div className="space-y-2">
            <SelectField id={ids.supplier} label="Supplier" value={supplierId} onChange={setSupplierId}>
              <option value="">Choose a supplier</option>
              {active.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </SelectField>
            {errors.supplier ? <p className="text-sm text-destructive">{errors.supplier}</p> : null}
            <Button type="button" variant="ghost" className="h-11 px-2" onClick={() => setAddingSupplier(true)}>
              New supplier
            </Button>
          </div>
        ) : (
          <p className="text-sm">
            Supplier: <span className="font-medium">{order?.supplierName}</span>
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField id={ids.ordered} label="Order date" type="date" value={orderDate} error={errors.orderDate} onChange={(e) => setOrderDate(e.target.value)} />
          <TextField id={ids.expected} label="Expected delivery" optional type="date" value={expectedDate} error={errors.expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
        </div>

        <fieldset className="space-y-3">
          <legend className="font-medium">Products</legend>
          <p className="text-sm text-muted-foreground">Cost per unit is what you pay the supplier: net of VAT if the business is VAT-registered, VAT-inclusive if not.</p>
          {lines.length > 0 ? (
            <ul aria-label="Order lines" className="space-y-2">
              {lines.map((line) => (
                <li key={line.key} className="space-y-2 rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium">
                      {line.product.name} <span className="font-mono text-xs text-muted-foreground">{line.product.sku}</span>
                    </p>
                    <button
                      type="button"
                      onClick={() => setLines(lines.filter((l) => l.key !== line.key))}
                      aria-label={`Remove ${line.product.name}`}
                      className="flex size-11 items-center justify-center rounded-md text-destructive hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <TextField
                      id={`qty-${line.key}`}
                      label={`${line.product.name} quantity`}
                      inputMode="decimal"
                      autoComplete="off"
                      value={line.quantity}
                      error={errors[`q-${line.key}`]}
                      onChange={(e) => setLines(lines.map((l) => (l.key === line.key ? { ...l, quantity: e.target.value } : l)))}
                    />
                    <TextField
                      id={`cost-${line.key}`}
                      label={`${line.product.name} cost per unit (KES)`}
                      inputMode="decimal"
                      autoComplete="off"
                      value={line.unitCost}
                      error={errors[`c-${line.key}`]}
                      onChange={(e) => setLines(lines.map((l) => (l.key === line.key ? { ...l, unitCost: e.target.value } : l)))}
                    />
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          <ProductPicker value={null} onChange={add} label="Add a product" error={errors.add || undefined} />
        </fieldset>

        <TextField id={ids.notes} label="Notes" optional autoComplete="off" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <Button type="submit" className="h-11" disabled={saving}>
          {saving ? "Saving…" : order ? "Save the draft" : "Save as draft"}
        </Button>
      </form>
    </div>
  );
}
