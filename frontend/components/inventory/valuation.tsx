"use client";

import { useId, useState } from "react";
import { TextField } from "@/components/auth/form-bits";
import { ErrorState, LoadingState } from "@/components/states/states";
import { businessToday, formatDate } from "@/lib/datetime";
import { useValuation } from "@/lib/inventory/inventory";
import { formatKES } from "@/lib/money";
import { displayQuantity } from "@/lib/pos/quantity";
import { cn } from "@/lib/utils";

// What the stock is worth — the server's figures, never the screen's: the total carrying value, the
// general-ledger balance of account 1200 Inventory it must equal, where the stock sits by location,
// and each product's value. Shown only to the roles the API lets read it (owner, accountant,
// auditor).

export function ValuationView() {
  const ids = { asOf: useId() };
  const [today] = useState(() => businessToday());
  const [asOf, setAsOf] = useState(today);
  const valuation = useValuation(asOf, /^\d{4}-\d{2}-\d{2}$/.test(asOf));

  return (
    <div className="space-y-5">
      <div className="max-w-xs">
        <TextField id={ids.asOf} label="As at" type="date" max={today} value={asOf} onChange={(e) => setAsOf(e.target.value)} />
      </div>
      {valuation.isPending ? (
        <LoadingState label="Loading the valuation" lines={5} />
      ) : valuation.isError ? (
        <ErrorState title="Couldn’t load the valuation" description={valuation.error.message} onRetry={() => void valuation.refetch()} />
      ) : (
        <>
          <section aria-label="Stock value" className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border p-4">
              <p className="text-sm text-muted-foreground">Stock value</p>
              <p className="font-display text-2xl font-semibold tabular-nums">KES {formatKES(valuation.data.totalStockValue)}</p>
              <p className="text-xs text-muted-foreground">as at {formatDate(valuation.data.asOf)}</p>
            </div>
            <div className="rounded-lg border p-4">
              <p className="text-sm text-muted-foreground">In the books (1200 Inventory)</p>
              <p className="font-display text-2xl font-semibold tabular-nums">KES {formatKES(valuation.data.reconciliation.glAccount1200Balance)}</p>
            </div>
            <div className={cn("rounded-lg border p-4", valuation.data.reconciliation.reconciled ? "border-emerald-700/40 bg-emerald-700/10" : "border-destructive/40 bg-destructive/10")}>
              <p className="text-sm text-muted-foreground">Agreement</p>
              <p className="font-display text-2xl font-semibold">{valuation.data.reconciliation.reconciled ? "Reconciled" : "Does not agree"}</p>
              <p className="text-xs text-muted-foreground">Difference KES {formatKES(valuation.data.reconciliation.difference)}</p>
            </div>
          </section>
          {!valuation.data.reconciliation.reconciled ? (
            <p role="alert" className="text-sm text-destructive">
              The stock value and the books disagree. Ask your accountant to look into it before relying on these figures.
            </p>
          ) : null}

          <section aria-labelledby="by-location" className="space-y-2">
            <h2 id="by-location" className="font-medium">
              By location
            </h2>
            <table className="w-full text-sm">
              <caption className="sr-only">Stock value by location</caption>
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th scope="col" className="py-1 pr-3 font-medium">Location</th>
                  <th scope="col" className="py-1 pr-3 text-right font-medium">Units</th>
                  <th scope="col" className="py-1 text-right font-medium">Value (KES)</th>
                </tr>
              </thead>
              <tbody>
                {valuation.data.byLocation.map((l) => (
                  <tr key={l.locationId} className="border-b last:border-b-0">
                    <td className="py-1.5 pr-3">{l.locationName}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{displayQuantity(l.quantity)}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatKES(l.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section aria-labelledby="by-product" className="space-y-2">
            <h2 id="by-product" className="font-medium">
              By product
            </h2>
            <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Stock value by product, scrollable">
              <table className="w-full min-w-[32rem] text-sm">
                <caption className="sr-only">Stock value by product</caption>
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th scope="col" className="py-1 pr-3 font-medium">Product</th>
                    <th scope="col" className="py-1 pr-3 text-right font-medium">On hand</th>
                    <th scope="col" className="py-1 pr-3 text-right font-medium">Average cost</th>
                    <th scope="col" className="py-1 text-right font-medium">Value (KES)</th>
                  </tr>
                </thead>
                <tbody>
                  {valuation.data.products.map((p) => (
                    <tr key={p.productId} className="border-b last:border-b-0">
                      <td className="py-1.5 pr-3">
                        {p.name} <span className="font-mono text-xs text-muted-foreground">{p.sku}</span>
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{displayQuantity(p.stockCount)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{formatKES(p.avgCost)}</td>
                      <td className="py-1.5 text-right tabular-nums">{formatKES(p.stockValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
