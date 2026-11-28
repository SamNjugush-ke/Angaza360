"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";
import { FormAlert, TextField } from "@/components/auth/form-bits";
import { useWorkingLocation } from "@/components/shell/location";
import { Done, ProductPicker, quantityProblem, SelectField, shillingsProblem, type PickedProduct } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { adjustStock, receiveStock, transferStock, useInvalidateStock, useSplit, useSuppliers, writeOffStock, type MovementResult, type TransferResult } from "@/lib/inventory/inventory";
import { centsToAmount, formatKES, parseMajorToCents } from "@/lib/money";
import { displayQuantity } from "@/lib/pos/quantity";

// Moving stock. Receive (from a supplier, without a purchase order), adjust up or down, and write
// off all act on the MAIN store — the API takes no location for them; a transfer moves owned stock
// between two locations and posts nothing to the ledger. Every form keeps what was typed when the
// server refuses (insufficient stock, a closed period), shows the refusal as written, and after a
// success shows where stock now stands. Amounts are typed in shillings and sent as "150.00".

export type StockAction = "receive" | "adjust" | "writeoff" | "transfer";

export const ACTION_TITLE: Readonly<Record<StockAction, string>> = {
  receive: "Receive stock",
  adjust: "Adjust stock",
  writeoff: "Write off stock",
  transfer: "Transfer stock",
};

const amount = (typed: string) => centsToAmount(parseMajorToCents(typed));
const failureOf = (failure: unknown) => (failure instanceof ApiHttpError ? failure.message : "That could not be saved. Please try again.");

function useMainName(): string {
  const place = useWorkingLocation();
  return place?.locations.find((l) => l.isDefault)?.name ?? "the main store";
}

interface FormProps {
  product: PickedProduct | null;
  onDone?: () => void;
}

function Shell({ title, error, onSubmit, saving, submitLabel, result, children, onAnother }: { title: string; error: string | null; onSubmit: (event: FormEvent) => void; saving: boolean; submitLabel: string; result: ReactNode; children: ReactNode; onAnother: () => void }) {
  const errorId = useId();
  if (result) {
    return (
      <div className="space-y-3">
        {result}
        <Button type="button" variant="outline" className="h-11" onClick={onAnother} data-autofocus>
          {title} again
        </Button>
      </div>
    );
  }
  return (
    <form noValidate onSubmit={onSubmit} className="space-y-4" aria-describedby={error ? errorId : undefined}>
      {error ? <FormAlert id={errorId}>{error}</FormAlert> : null}
      {children}
      <Button type="submit" className="h-11 w-full sm:w-auto" disabled={saving}>
        {saving ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}

function movedTo(result: MovementResult, unit: string): ReactNode {
  return (
    <>
      Stock now <span className="font-semibold tabular-nums">{displayQuantity(result.balanceQty)}</span> {unit} across all locations, carried at KES{" "}
      {formatKES(result.balanceValue)}.
    </>
  );
}

export function ReceiveForm({ product: given, canPickSupplier, onDone }: FormProps & { canPickSupplier: boolean }) {
  const ids = { qty: useId(), cost: useId(), supplier: useId(), reference: useId(), notes: useId(), paid: useId() };
  const main = useMainName();
  const suppliers = useSuppliers(canPickSupplier);
  const invalidate = useInvalidateStock();
  const [product, setProduct] = useState<PickedProduct | null>(given);
  const [quantity, setQuantity] = useState("");
  const [cost, setCost] = useState(given ? centsToAmount(given.costPrice) : "");
  const [supplierId, setSupplierId] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [paid, setPaid] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<MovementResult | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (!product) found.product = "Choose the product you are receiving.";
    const q = quantityProblem(quantity);
    if (q) found.quantity = q;
    const c = shillingsProblem(cost);
    if (c) found.cost = c;
    setErrors(found);
    if (Object.keys(found).length > 0 || !product) return;
    setSaving(true);
    setError(null);
    try {
      setResult(
        await receiveStock({
          productId: product.id,
          quantity: quantity.trim(),
          unitCost: amount(cost),
          ...(supplierId ? { supplierId } : {}),
          ...(reference.trim() ? { reference: reference.trim() } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          paidImmediately: paid,
        }),
      );
      await invalidate();
      onDone?.();
    } catch (failure) {
      setError(failureOf(failure));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Shell
      title="Receive stock"
      error={error}
      onSubmit={(event) => void submit(event)}
      saving={saving}
      submitLabel="Receive into stock"
      onAnother={() => {
        setResult(null);
        setQuantity("");
      }}
      result={
        result && product ? (
          <Done>
            Received {displayQuantity(result.quantity)} {product.unitOfMeasure} of {product.name} into {main} (KES {formatKES(result.totalCost)}). {movedTo(result, product.unitOfMeasure)}
          </Done>
        ) : null
      }
    >
      <p className="text-sm text-muted-foreground">Goes into {main}. To receive against a purchase order, receive it from the order in Procurement.</p>
      {given ? null : <ProductPicker value={product} onChange={setProduct} error={errors.product} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField id={ids.qty} label={`Quantity${product ? ` (${product.unitOfMeasure})` : ""}`} inputMode="decimal" autoComplete="off" value={quantity} error={errors.quantity} onChange={(e) => setQuantity(e.target.value)} />
        <TextField id={ids.cost} label="Cost per unit (KES)" inputMode="decimal" autoComplete="off" value={cost} error={errors.cost} onChange={(e) => setCost(e.target.value)} />
      </div>
      {canPickSupplier ? (
        <SelectField id={ids.supplier} label="Supplier (optional)" value={supplierId} onChange={setSupplierId}>
          <option value="">No supplier recorded</option>
          {(suppliers.data?.data ?? [])
            .filter((s) => s.isActive)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </SelectField>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField id={ids.reference} label="Reference" optional autoComplete="off" placeholder="e.g. delivery note no." value={reference} onChange={(e) => setReference(e.target.value)} />
        <TextField id={ids.notes} label="Notes" optional autoComplete="off" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <label htmlFor={ids.paid} className="flex min-h-11 items-center gap-3 text-sm">
        <input id={ids.paid} type="checkbox" className="size-5" checked={paid} onChange={(e) => setPaid(e.target.checked)} />
        Paid now in cash (otherwise it is owed to the supplier)
      </label>
    </Shell>
  );
}

export function AdjustForm({ product: given, onDone }: FormProps) {
  const ids = { dir: useId(), qty: useId(), cost: useId(), reason: useId(), reference: useId() };
  const main = useMainName();
  const invalidate = useInvalidateStock();
  const [product, setProduct] = useState<PickedProduct | null>(given);
  const [direction, setDirection] = useState<"ADJUSTMENT_INCREASE" | "ADJUSTMENT_DECREASE">("ADJUSTMENT_DECREASE");
  const [quantity, setQuantity] = useState("");
  const [cost, setCost] = useState(given ? centsToAmount(given.costPrice) : "");
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<MovementResult | null>(null);
  const up = direction === "ADJUSTMENT_INCREASE";

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (!product) found.product = "Choose the product to adjust.";
    const q = quantityProblem(quantity);
    if (q) found.quantity = q;
    if (up) {
      const c = shillingsProblem(cost);
      if (c) found.cost = c;
    }
    if (reason.trim() === "") found.reason = "Give a reason — it is kept with the movement.";
    setErrors(found);
    if (Object.keys(found).length > 0 || !product) return;
    setSaving(true);
    setError(null);
    try {
      setResult(
        await adjustStock({
          productId: product.id,
          movementType: direction,
          quantity: quantity.trim(),
          ...(up ? { unitCost: amount(cost) } : {}),
          notes: reason.trim(),
          ...(reference.trim() ? { reference: reference.trim() } : {}),
        }),
      );
      await invalidate();
      onDone?.();
    } catch (failure) {
      setError(failureOf(failure));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Shell
      title="Adjust stock"
      error={error}
      onSubmit={(event) => void submit(event)}
      saving={saving}
      submitLabel={up ? "Adjust up" : "Adjust down"}
      onAnother={() => {
        setResult(null);
        setQuantity("");
        setReason("");
      }}
      result={
        result && product ? (
          <Done>
            {up ? "Added" : "Removed"} {displayQuantity(result.quantity)} {product.unitOfMeasure} of {product.name} at {main}. {movedTo(result, product.unitOfMeasure)}
          </Done>
        ) : null
      }
    >
      <p className="text-sm text-muted-foreground">Corrects the count at {main}, e.g. after a stock-take.</p>
      {given ? null : <ProductPicker value={product} onChange={setProduct} error={errors.product} />}
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">Direction</legend>
        <div className="flex flex-wrap gap-x-6">
          {(
            [
              ["ADJUSTMENT_DECREASE", "Down — fewer than recorded"],
              ["ADJUSTMENT_INCREASE", "Up — more than recorded"],
            ] as const
          ).map(([value, text]) => (
            <label key={value} className="flex min-h-11 items-center gap-2 text-sm">
              <input type="radio" name={ids.dir} className="size-4" checked={direction === value} onChange={() => setDirection(value)} />
              {text}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField id={ids.qty} label={`Quantity${product ? ` (${product.unitOfMeasure})` : ""}`} inputMode="decimal" autoComplete="off" value={quantity} error={errors.quantity} onChange={(e) => setQuantity(e.target.value)} />
        {up ? (
          <TextField id={ids.cost} label="Value per unit (KES)" hint="What each extra unit is worth." inputMode="decimal" autoComplete="off" value={cost} error={errors.cost} onChange={(e) => setCost(e.target.value)} />
        ) : null}
      </div>
      <div className="space-y-2">
        <Label htmlFor={ids.reason}>Reason</Label>
        <textarea
          id={ids.reason}
          rows={2}
          value={reason}
          aria-invalid={errors.reason ? true : undefined}
          aria-describedby={errors.reason ? `${ids.reason}-error` : undefined}
          onChange={(e) => setReason(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {errors.reason ? (
          <p id={`${ids.reason}-error`} className="text-sm text-destructive">
            {errors.reason}
          </p>
        ) : null}
      </div>
      <TextField id={ids.reference} label="Reference" optional autoComplete="off" value={reference} onChange={(e) => setReference(e.target.value)} />
    </Shell>
  );
}

export function WriteOffForm({ product: given, onDone }: FormProps) {
  const ids = { qty: useId(), reason: useId(), reference: useId() };
  const main = useMainName();
  const invalidate = useInvalidateStock();
  const [product, setProduct] = useState<PickedProduct | null>(given);
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<MovementResult | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (!product) found.product = "Choose the product to write off.";
    const q = quantityProblem(quantity);
    if (q) found.quantity = q;
    if (reason.trim() === "") found.reason = "Give a reason — damaged, expired, missing…";
    setErrors(found);
    if (Object.keys(found).length > 0 || !product) return;
    setSaving(true);
    setError(null);
    try {
      setResult(await writeOffStock({ productId: product.id, quantity: quantity.trim(), notes: reason.trim(), ...(reference.trim() ? { reference: reference.trim() } : {}) }));
      await invalidate();
      onDone?.();
    } catch (failure) {
      setError(failureOf(failure));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Shell
      title="Write off stock"
      error={error}
      onSubmit={(event) => void submit(event)}
      saving={saving}
      submitLabel="Write off"
      onAnother={() => {
        setResult(null);
        setQuantity("");
        setReason("");
      }}
      result={
        result && product ? (
          <Done>
            Wrote off {displayQuantity(result.quantity)} {product.unitOfMeasure} of {product.name} from {main} — a loss of KES {formatKES(result.totalCost)}. {movedTo(result, product.unitOfMeasure)}
          </Done>
        ) : null
      }
    >
      <p className="text-sm text-muted-foreground">Removes damaged, expired or missing stock from {main} and books its cost as a loss.</p>
      {given ? null : <ProductPicker value={product} onChange={setProduct} error={errors.product} />}
      <TextField id={ids.qty} label={`Quantity${product ? ` (${product.unitOfMeasure})` : ""}`} inputMode="decimal" autoComplete="off" value={quantity} error={errors.quantity} onChange={(e) => setQuantity(e.target.value)} />
      <TextField id={ids.reason} label="Reason" autoComplete="off" value={reason} error={errors.reason} onChange={(e) => setReason(e.target.value)} />
      <TextField id={ids.reference} label="Reference" optional autoComplete="off" value={reference} onChange={(e) => setReference(e.target.value)} />
    </Shell>
  );
}

function Holdings({ productId }: { productId: string }) {
  const split = useSplit(productId);
  if (!split.data) return null;
  return (
    <p className="text-sm text-muted-foreground" aria-live="polite">
      Held now: {split.data.locations.length === 0 ? "nowhere" : split.data.locations.map((l) => `${l.locationName} ${displayQuantity(l.quantity)}`).join(" · ")}
    </p>
  );
}

export function TransferForm({ product: given, onDone }: FormProps) {
  const ids = { from: useId(), to: useId(), qty: useId(), notes: useId() };
  const place = useWorkingLocation();
  const locations = place?.locations ?? [];
  const invalidate = useInvalidateStock();
  const [product, setProduct] = useState<PickedProduct | null>(given);
  const [from, setFrom] = useState(locations.find((l) => l.isDefault)?.id ?? "");
  const [to, setTo] = useState("");
  const [quantity, setQuantity] = useState("");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<TransferResult | null>(null);
  const nameOf = (id: string) => locations.find((l) => l.id === id)?.name ?? "the location";

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (!product) found.product = "Choose the product to move.";
    if (from === "") found.from = "Choose where the stock comes from.";
    if (to === "") found.to = "Choose where it goes.";
    else if (to === from) found.to = "Choose a different location from the one it leaves.";
    const q = quantityProblem(quantity);
    if (q) found.quantity = q;
    setErrors(found);
    if (Object.keys(found).length > 0 || !product) return;
    setSaving(true);
    setError(null);
    try {
      setResult(await transferStock({ productId: product.id, fromLocationId: from, toLocationId: to, quantity: quantity.trim(), ...(notes.trim() ? { notes: notes.trim() } : {}) }));
      await invalidate();
      onDone?.();
    } catch (failure) {
      setError(failureOf(failure));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Shell
      title="Transfer stock"
      error={error}
      onSubmit={(event) => void submit(event)}
      saving={saving}
      submitLabel="Transfer"
      onAnother={() => {
        setResult(null);
        setQuantity("");
      }}
      result={
        result && product ? (
          <Done>
            Moved {displayQuantity(result.quantity)} {product.unitOfMeasure} of {product.name}: {nameOf(result.fromLocationId)} now holds{" "}
            <span className="font-semibold tabular-nums">{displayQuantity(result.fromQuantityAfter)}</span>, {nameOf(result.toLocationId)} now holds{" "}
            <span className="font-semibold tabular-nums">{displayQuantity(result.toQuantityAfter)}</span>. The business-wide total is unchanged ({displayQuantity(result.productStockCount)}).
          </Done>
        ) : null
      }
    >
      <p className="text-sm text-muted-foreground">Moves stock a location owns to another. Nothing is bought or sold, so nothing is posted to the books.</p>
      {given ? null : <ProductPicker value={product} onChange={setProduct} error={errors.product} />}
      {product ? <Holdings productId={product.id} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <SelectField id={ids.from} label="From" value={from} onChange={setFrom}>
            <option value="">Choose a location</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </SelectField>
          {errors.from ? <p className="text-sm text-destructive">{errors.from}</p> : null}
        </div>
        <div className="space-y-1">
          <SelectField id={ids.to} label="To" value={to} onChange={setTo}>
            <option value="">Choose a location</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </SelectField>
          {errors.to ? <p className="text-sm text-destructive">{errors.to}</p> : null}
        </div>
      </div>
      <TextField id={ids.qty} label={`Quantity${product ? ` (${product.unitOfMeasure})` : ""}`} inputMode="decimal" autoComplete="off" value={quantity} error={errors.quantity} onChange={(e) => setQuantity(e.target.value)} />
      <TextField id={ids.notes} label="Notes" optional autoComplete="off" value={notes} onChange={(e) => setNotes(e.target.value)} />
    </Shell>
  );
}
