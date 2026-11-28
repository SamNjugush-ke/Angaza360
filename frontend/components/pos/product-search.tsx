"use client";

import { ScanLine } from "lucide-react";
import { forwardRef, useId, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchProducts } from "@/lib/catalog/api";
import { useDebounced, useProducts } from "@/lib/catalog/hooks";
import { DEFAULT_FILTERS, type Product } from "@/lib/catalog/types";
import { formatKES } from "@/lib/money";
import type { CartProduct } from "@/lib/pos/cart";

// The scan / search box. Typing searches the catalog on the server (name, SKU or barcode; active
// products only) through the catalog's own hook. ENTER adds at once: a scanner types the barcode
// faster than any debounce and presses Enter, so Enter looks the code up immediately and adds the
// exact SKU / barcode match (or the only match). After an add the box clears and keeps focus.

export const toCartProduct = (product: Product): CartProduct => ({
  id: product.id,
  sku: product.sku,
  name: product.name,
  kind: product.kind,
  unitOfMeasure: product.unitOfMeasure,
  price: product.price,
});

function exactMatch(products: readonly Product[], code: string): Product | null {
  const wanted = code.trim().toLowerCase();
  return products.find((product) => product.sku.toLowerCase() === wanted || (product.barcode ?? "").toLowerCase() === wanted) ?? (products.length === 1 ? (products[0] ?? null) : null);
}

export interface ProductSearchProps {
  onAdd: (product: CartProduct) => void;
}

export const ProductSearch = forwardRef<HTMLInputElement, ProductSearchProps>(function ProductSearch({ onAdd }, ref) {
  const ids = { input: useId(), results: useId(), status: useId() };
  const [typed, setTyped] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const q = useDebounced(typed.trim(), 250);
  const search = useProducts({ ...DEFAULT_FILTERS, q }, 0);
  const results = q === "" ? [] : (search.data?.data ?? []).slice(0, 8);

  function add(product: Product) {
    onAdd(toCartProduct(product));
    setTyped("");
    setNotice(`${product.name} added`);
  }

  async function onEnter() {
    const code = typed.trim();
    if (code === "") return;
    try {
      const found = await fetchProducts({ ...DEFAULT_FILTERS, q: code }, 0, 10);
      const match = exactMatch(found.data, code);
      if (match) add(match);
      else setNotice(found.data.length === 0 ? `Nothing matches “${code}”.` : "Several products match — pick one from the list.");
    } catch {
      setNotice("The search could not reach the server. Try again.");
    }
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={ids.input}>Scan or search products</Label>
      <div className="relative">
        <ScanLine className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          ref={ref}
          id={ids.input}
          type="search"
          autoComplete="off"
          autoFocus
          placeholder="Barcode, SKU or name"
          className="h-12 pl-10 text-base"
          aria-controls={results.length > 0 ? ids.results : undefined}
          aria-describedby={ids.status}
          value={typed}
          onChange={(event) => {
            setTyped(event.target.value);
            setNotice(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void onEnter();
            }
          }}
        />
      </div>
      <p id={ids.status} className="min-h-5 text-sm text-muted-foreground" aria-live="polite">
        {notice ?? (q !== "" && search.isFetching ? "Searching…" : "")}
      </p>
      {results.length > 0 ? (
        <ul id={ids.results} aria-label="Matching products" className="max-h-72 space-y-1 overflow-y-auto">
          {results.map((product) => (
            <li key={product.id}>
              <button
                type="button"
                onClick={() => add(product)}
                className="flex min-h-12 w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{product.name}</span>
                  <span className="block font-mono text-xs text-muted-foreground">{product.sku}</span>
                </span>
                <span className="shrink-0 tabular-nums">KES {formatKES(product.price)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
});
