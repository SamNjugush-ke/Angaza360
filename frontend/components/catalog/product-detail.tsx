"use client";

import { Pencil } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { CatalogPermissions } from "@/lib/catalog/permissions";
import { KIND_LABEL, TAX_CLASS_LABEL, type Product } from "@/lib/catalog/types";
import { formatKES } from "@/lib/money";
import { KindBadge, StatusBadge } from "./badges";

// A product's details, read-only. Every role that can open the catalog sees this; the write
// controls below it render only for the roles the backend lets use them.

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b py-2 text-sm last:border-b-0">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

/** A decimal-string quantity shown without trailing zeros: "12.500" → "12.5". Text only — no arithmetic. */
export function formatQuantity(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

export interface ProductDetailProps {
  product: Product;
  permissions: CatalogPermissions;
  onEdit: () => void;
  /** The manage panel (reorder policy, tax class, activation) — rendered below the details. */
  children?: ReactNode;
}

export function ProductDetail({ product, permissions, onEdit, children }: ProductDetailProps) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <KindBadge kind={product.kind} />
        <StatusBadge active={product.isActive} />
      </div>
      <dl>
        <Row term="SKU">{product.sku}</Row>
        <Row term="Selling price">{formatKES(product.price, { currency: true })}</Row>
        <Row term="Cost price">{formatKES(product.costPrice, { currency: true })}</Row>
        <Row term="Tax class">{TAX_CLASS_LABEL[product.taxClass]}</Row>
        <Row term="Kind">{KIND_LABEL[product.kind]}</Row>
        <Row term="Unit">{product.unitOfMeasure}</Row>
        <Row term="Category">{product.category ?? "—"}</Row>
        <Row term="Barcode">{product.barcode ?? "—"}</Row>
        {product.kind === "GOOD" ? (
          <Row term="In stock">
            {formatQuantity(product.stockCount)} {product.unitOfMeasure}
          </Row>
        ) : null}
      </dl>
      {permissions.canEdit ? (
        <Button type="button" variant="outline" className="h-11 w-full sm:w-auto" onClick={onEdit}>
          <Pencil aria-hidden /> Edit details
        </Button>
      ) : null}
      {children}
    </div>
  );
}
