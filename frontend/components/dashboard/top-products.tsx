"use client";

import type { TopProduct } from "@/lib/dashboard/types";
import { formatKES } from "@/lib/money";
import { cn } from "@/lib/utils";

/** "231.000" → "231", "2.500" → "2.5": a quantity as people read it. */
export function displayQuantity(quantity: string): string {
  return quantity.includes(".") ? quantity.replace(/\.?0+$/, "") : quantity;
}

export function TopProductsBody({ products }: { products: readonly TopProduct[] }) {
  if (products.length === 0) return <p className="text-sm text-muted-foreground">No sales in this period.</p>;
  return (
    <ol className="space-y-3">
      {products.map((product, index) => (
        <li key={product.productId} className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="tabular w-5 shrink-0 text-sm text-muted-foreground" aria-hidden>
              {index + 1}
            </span>
            <div className="min-w-0">
              <p className="truncate font-medium">{product.name}</p>
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <span
                  className={cn(
                    "rounded border px-1.5 text-xs font-medium",
                    product.kind === "SERVICE" ? "border-primary/40 text-primary" : "border-input text-muted-foreground",
                  )}
                >
                  {product.kind === "SERVICE" ? "Service" : "Product"}
                </span>
                <span className="tabular">{displayQuantity(product.quantity)} sold</span>
              </p>
            </div>
          </div>
          <span className="tabular shrink-0 font-medium">{formatKES(product.revenue)}</span>
        </li>
      ))}
    </ol>
  );
}
