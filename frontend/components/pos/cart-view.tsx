"use client";

import { Minus, Plus, Trash2 } from "lucide-react";
import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatKES } from "@/lib/money";
import { lineProblem, type CartAction, type CartLine } from "@/lib/pos/cart";
import { displayQuantity, exceeds } from "@/lib/pos/quantity";
import type { Quote } from "@/lib/pos/types";
import { cn } from "@/lib/utils";

// The cart. Each line is what the cashier typed; its line total and the stock warning come from
// the server's quote, which is the only source of a price.

const stepper =
  "flex size-11 shrink-0 items-center justify-center rounded-md border hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

function CartRow({ line, quoted, locationName, dispatch }: { line: CartLine; quoted: Quote["lines"][number] | undefined; locationName: string; dispatch: (action: CartAction) => void }) {
  const ids = { qty: useId(), discount: useId(), note: useId() };
  const problem = lineProblem(line);
  const short = quoted?.sellable !== null && quoted?.sellable !== undefined && exceeds(line.quantity, quoted.sellable);
  const note = problem ?? (short ? `Only ${displayQuantity(quoted?.sellable ?? "0")} ${line.product.unitOfMeasure} left at ${locationName}.` : null);
  const id = line.product.id;

  return (
    <li className={cn("space-y-2 rounded-lg border p-3", note && "border-destructive/50")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{line.product.name}</p>
          <p className="font-mono text-xs text-muted-foreground">{line.product.sku}</p>
        </div>
        <p className="shrink-0 font-semibold tabular-nums">{quoted ? `KES ${formatKES(quoted.lineTotal)}` : "—"}</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor={ids.qty}>Quantity</Label>
          <div className="flex items-center gap-1">
            <button type="button" className={stepper} aria-label={`One less ${line.product.name}`} onClick={() => dispatch({ type: "step", productId: id, delta: -1 })}>
              <Minus className="size-4" aria-hidden />
            </button>
            <Input
              id={ids.qty}
              inputMode="decimal"
              autoComplete="off"
              className="h-11 w-20 text-center tabular-nums"
              value={line.quantity}
              aria-invalid={note ? true : undefined}
              aria-describedby={note ? ids.note : undefined}
              onChange={(event) => dispatch({ type: "quantity", productId: id, quantity: event.target.value })}
            />
            <button type="button" className={stepper} aria-label={`One more ${line.product.name}`} onClick={() => dispatch({ type: "step", productId: id, delta: 1 })}>
              <Plus className="size-4" aria-hidden />
            </button>
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor={ids.discount}>Discount (KES)</Label>
          <Input
            id={ids.discount}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            className="h-11 w-28 tabular-nums"
            value={line.discount}
            onChange={(event) => dispatch({ type: "discount", productId: id, discount: event.target.value })}
          />
        </div>
        <button type="button" className={cn(stepper, "ml-auto text-destructive")} aria-label={`Remove ${line.product.name}`} onClick={() => dispatch({ type: "remove", productId: id })}>
          <Trash2 className="size-4" aria-hidden />
        </button>
      </div>
      {note ? (
        <p id={ids.note} className="text-sm text-destructive">
          {note}
        </p>
      ) : null}
    </li>
  );
}

export function CartView({ lines, quote, locationName, dispatch }: { lines: readonly CartLine[]; quote: Quote | undefined; locationName: string; dispatch: (action: CartAction) => void }) {
  if (lines.length === 0) {
    return <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">Scan or search for a product to start a sale.</p>;
  }
  return (
    <ul aria-label="Cart" className="space-y-2">
      {lines.map((line) => (
        <CartRow key={line.product.id} line={line} quoted={quote?.lines.find((row) => row.productId === line.product.id)} locationName={locationName} dispatch={dispatch} />
      ))}
    </ul>
  );
}

/** True when any line asks for more than the location may sell. */
export function overSellable(lines: readonly CartLine[], quote: Quote | undefined): boolean {
  if (!quote) return false;
  return lines.some((line) => {
    const quoted = quote.lines.find((row) => row.productId === line.product.id);
    return quoted?.sellable !== null && quoted?.sellable !== undefined && exceeds(line.quantity, quoted.sellable);
  });
}

export function Totals({ quote, updating, error }: { quote: Quote | undefined; updating: boolean; error: string | null }) {
  return (
    <section aria-label="Sale total" className="space-y-1 rounded-lg bg-muted p-4" aria-live="polite" aria-busy={updating}>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="flex justify-between text-sm">
        <span>Subtotal</span>
        <span className="tabular-nums">{quote ? formatKES(quote.subtotal) : "—"}</span>
      </div>
      <div className="flex justify-between text-sm">
        <span>VAT</span>
        <span className="tabular-nums">{quote ? formatKES(quote.vatTotal) : "—"}</span>
      </div>
      <div className="flex items-baseline justify-between pt-1">
        <span className="font-semibold">Total</span>
        <span className="font-display text-2xl font-semibold tabular-nums">{quote ? `KES ${formatKES(quote.total)}` : "—"}</span>
      </div>
      <p className="min-h-4 text-xs text-muted-foreground">{updating ? "Updating total…" : ""}</p>
    </section>
  );
}
