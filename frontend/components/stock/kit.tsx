"use client";

import { Search } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDebounced, useProducts } from "@/lib/catalog/hooks";
import type { Product } from "@/lib/catalog/types";
import { parseMajorToCents } from "@/lib/money";
import { isQuantity, toMilli } from "@/lib/pos/quantity";
import { cn } from "@/lib/utils";

// The pieces the stock and procurement screens share: tabs, a goods picker over the catalog, a
// labelled select, and the input checks — amounts typed in shillings, quantities as decimals.
// Nothing here computes money: it only checks that what was typed is a valid amount.

export const SELECT_CLASS =
  "flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60 md:text-sm";

/** A shilling amount as the API takes it ("150.00"), or why it is not one. */
export function shillingsProblem(typed: string, { allowZero = true } = {}): string | null {
  if (typed.trim() === "") return "Enter an amount in shillings.";
  try {
    const cents = parseMajorToCents(typed);
    if (cents < 0n) return "The amount cannot be negative.";
    if (!allowZero && cents === 0n) return "Enter an amount above 0.";
    return null;
  } catch {
    return "Enter an amount in shillings, e.g. 1,250.50.";
  }
}

/** A quantity above zero with at most three decimals, or why it is not one. */
export function quantityProblem(typed: string): string | null {
  if (!isQuantity(typed)) return "Enter a quantity, e.g. 12 or 2.5 (up to three decimals).";
  return toMilli(typed) > 0n ? null : "Enter a quantity above 0.";
}

export interface Tab {
  id: string;
  label: string;
}

/** A tab list with arrow-key movement; the panel is the caller's, labelled by the active tab. */
export function Tabs({ tabs, active, onChange, label }: { tabs: readonly Tab[]; active: string; onChange: (id: string) => void; label: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  function onKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + tabs.length) % tabs.length;
    const tab = tabs[next];
    if (!tab) return;
    onChange(tab.id);
    refs.current[next]?.focus();
  }
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b">
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          ref={(node) => {
            refs.current[index] = node;
          }}
          type="button"
          role="tab"
          id={`tab-${tab.id}`}
          aria-selected={tab.id === active}
          aria-controls={`panel-${tab.id}`}
          tabIndex={tab.id === active ? 0 : -1}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => onKey(event, index)}
          className={cn(
            "min-h-11 whitespace-nowrap border-b-2 px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            tab.id === active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} className="pt-4">
      {children}
    </div>
  );
}

export interface PickedProduct {
  id: string;
  name: string;
  sku: string;
  unitOfMeasure: string;
  costPrice: string;
}

const pick = (product: Product): PickedProduct => ({ id: product.id, name: product.name, sku: product.sku, unitOfMeasure: product.unitOfMeasure, costPrice: product.costPrice });

/** Choose a GOOD from the catalog (services carry no stock), by name, SKU or barcode. */
export function ProductPicker({ value, onChange, label = "Product", error }: { value: PickedProduct | null; onChange: (product: PickedProduct | null) => void; label?: string; error?: string }) {
  const ids = { input: useId(), error: useId() };
  const [typed, setTyped] = useState("");
  const q = useDebounced(typed.trim(), 250);
  const results = useProducts({ q, category: "", kind: "GOOD", active: "true" }, 0);
  if (value) {
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium">{label}</p>
        <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
          <span>
            <span className="font-medium">{value.name}</span> <span className="font-mono text-xs text-muted-foreground">{value.sku}</span>
          </span>
          <Button type="button" variant="ghost" className="h-11" onClick={() => onChange(null)}>
            Change {label.toLowerCase()}
          </Button>
        </div>
      </div>
    );
  }
  const shown = q === "" ? [] : (results.data?.data ?? []).slice(0, 8);
  return (
    <div className="space-y-2">
      <Label htmlFor={ids.input}>{label}</Label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          id={ids.input}
          type="search"
          className="h-11 pl-9"
          placeholder="Search by name, SKU or barcode"
          autoComplete="off"
          value={typed}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? ids.error : undefined}
          onChange={(event) => setTyped(event.target.value)}
        />
      </div>
      {error ? (
        <p id={ids.error} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {q !== "" ? (
        <ul aria-label={`${label} matches`} className="max-h-64 divide-y overflow-y-auto rounded-md border" aria-live="polite">
          {results.isPending ? (
            <li className="px-3 py-2 text-sm text-muted-foreground">Searching…</li>
          ) : shown.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted-foreground">No goods match “{q}”.</li>
          ) : (
            shown.map((product) => (
              <li key={product.id}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(pick(product));
                    setTyped("");
                  }}
                  className="flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span>{product.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{product.sku}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

export function SelectField({ id, label, value, onChange, children, disabled, hint }: { id: string; label: string; value: string; onChange: (value: string) => void; children: ReactNode; disabled?: boolean; hint?: string }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <select id={id} className={SELECT_CLASS} value={value} disabled={disabled} aria-describedby={hint ? `${id}-hint` : undefined} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** A small result box after a write: what was done and where stock stands now. */
export function Done({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="rounded-md border border-emerald-700/40 bg-emerald-700/10 px-3 py-2 text-sm">
      {children}
    </div>
  );
}
