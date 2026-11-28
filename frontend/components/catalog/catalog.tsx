"use client";

import { Plus, Search, Upload } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet } from "@/components/ui/sheet";
import type { Role } from "@/lib/auth/landing";
import { useCategories, useDebounced, useProducts } from "@/lib/catalog/hooks";
import { catalogPermissions, type CatalogPermissions } from "@/lib/catalog/permissions";
import { DEFAULT_FILTERS, PAGE_SIZE, TAX_CLASS_LABEL, type Product, type ProductFilters } from "@/lib/catalog/types";
import { formatKES } from "@/lib/money";
import { cn } from "@/lib/utils";
import { KindBadge, StatusBadge } from "./badges";
import { ImportSheet } from "./import-sheet";
import { ProductDetail } from "./product-detail";
import { ProductForm } from "./product-form";
import { ProductManage } from "./product-manage";

// The product & service catalog. The list is filtered and paged by the SERVER (q over name, SKU
// and barcode; category; kind; active status), so a search covers the whole catalog and the
// total is the filtered count. Desktop shows a table, a phone a list of cards. Selecting a
// product opens its details in a side sheet, where the role's write controls live.

export type Panel =
  | { kind: "create" }
  | { kind: "detail"; product: Product }
  | { kind: "edit"; product: Product }
  | { kind: "import" };

const SELECT_CLASS =
  "flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:text-sm";

function isDefault(filters: ProductFilters): boolean {
  return filters.q.trim() === "" && filters.category === "" && filters.kind === "" && filters.active === DEFAULT_FILTERS.active;
}

function Filters({ value, onChange, categories }: { value: ProductFilters; onChange: (next: ProductFilters) => void; categories: readonly string[] }) {
  const ids = { q: useId(), category: useId(), kind: useId(), active: useId() };
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]" role="search">
      <div className="space-y-2">
        <Label htmlFor={ids.q}>Search</Label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            id={ids.q}
            type="search"
            className="h-11 pl-9"
            placeholder="Name, SKU or barcode"
            autoComplete="off"
            value={value.q}
            onChange={(event) => onChange({ ...value, q: event.target.value })}
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor={ids.category}>Category</Label>
        <select id={ids.category} className={SELECT_CLASS} value={value.category} onChange={(event) => onChange({ ...value, category: event.target.value })}>
          <option value="">All categories</option>
          {categories.map((category) => (
            <option key={category} value={category}>
              {category}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor={ids.kind}>Kind</Label>
        <select id={ids.kind} className={SELECT_CLASS} value={value.kind} onChange={(event) => onChange({ ...value, kind: event.target.value as ProductFilters["kind"] })}>
          <option value="">Goods and services</option>
          <option value="GOOD">Goods</option>
          <option value="SERVICE">Services</option>
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor={ids.active}>Status</Label>
        <select id={ids.active} className={SELECT_CLASS} value={value.active} onChange={(event) => onChange({ ...value, active: event.target.value as ProductFilters["active"] })}>
          <option value="true">Active</option>
          <option value="false">Inactive</option>
          <option value="">All</option>
        </select>
      </div>
    </div>
  );
}

function ProductTable({ products, onOpen }: { products: readonly Product[]; onOpen: (product: Product) => void }) {
  return (
    <table className="hidden w-full text-sm md:table">
      <caption className="sr-only">Products and services</caption>
      <thead>
        <tr className="border-b text-left text-muted-foreground">
          <th scope="col" className="py-2 pr-4 font-medium">Name</th>
          <th scope="col" className="py-2 pr-4 font-medium">SKU</th>
          <th scope="col" className="py-2 pr-4 font-medium">Kind</th>
          <th scope="col" className="py-2 pr-4 text-right font-medium">Price (KES)</th>
          <th scope="col" className="py-2 pr-4 font-medium">Tax class</th>
          <th scope="col" className="py-2 font-medium">Status</th>
        </tr>
      </thead>
      <tbody>
        {products.map((product) => (
          <tr key={product.id} className="border-b last:border-b-0">
            <td className="py-1 pr-4">
              <button
                type="button"
                onClick={() => onOpen(product)}
                className="min-h-11 rounded-sm text-left font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {product.name}
              </button>
            </td>
            <td className="py-1 pr-4 font-mono text-xs">{product.sku}</td>
            <td className="py-1 pr-4"><KindBadge kind={product.kind} /></td>
            <td className="py-1 pr-4 text-right tabular-nums">{formatKES(product.price)}</td>
            <td className="py-1 pr-4">{TAX_CLASS_LABEL[product.taxClass]}</td>
            <td className="py-1"><StatusBadge active={product.isActive} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ProductCards({ products, onOpen }: { products: readonly Product[]; onOpen: (product: Product) => void }) {
  return (
    <ul className="space-y-2 md:hidden" aria-label="Products and services">
      {products.map((product) => (
        <li key={product.id}>
          <button
            type="button"
            onClick={() => onOpen(product)}
            className="flex min-h-11 w-full flex-col gap-2 rounded-lg border p-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex w-full items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="block truncate font-medium">{product.name}</span>
                <span className="block font-mono text-xs text-muted-foreground">{product.sku}</span>
              </span>
              <span className="shrink-0 font-medium tabular-nums">KES {formatKES(product.price)}</span>
            </span>
            <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <KindBadge kind={product.kind} />
              <StatusBadge active={product.isActive} />
              <span>{TAX_CLASS_LABEL[product.taxClass]}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Pagination({ page, total, onPage, busy }: { page: number; total: number; onPage: (page: number) => void; busy: boolean }) {
  const first = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const last = Math.min(total, (page + 1) * PAGE_SIZE);
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-3 pt-2">
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {total === 0 ? "No products" : `Showing ${first.toString()}–${last.toString()} of ${total.toString()}`}
      </p>
      <div className="flex gap-2">
        <Button type="button" variant="outline" className="h-11" disabled={busy || page === 0} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button type="button" variant="outline" className="h-11" disabled={busy || page >= lastPage} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </nav>
  );
}

export interface CatalogProps {
  role: Role;
}

export function Catalog({ role }: CatalogProps) {
  const permissions: CatalogPermissions = catalogPermissions(role);
  const [typed, setTyped] = useState<ProductFilters>(DEFAULT_FILTERS);
  const q = useDebounced(typed.q, 300);
  const filters: ProductFilters = { ...typed, q };
  const filterKey = JSON.stringify(filters);
  // The page belongs to one set of filters: changing any filter starts again at page 1.
  const [paging, setPaging] = useState({ key: filterKey, page: 0 });
  const page = paging.key === filterKey ? paging.page : 0;
  const [panel, setPanel] = useState<Panel | null>(null);

  const products = useProducts(filters, page);
  const categories = useCategories();
  const categoryOptions = categories.data?.data ?? [];

  const open = (product: Product) => setPanel({ kind: "detail", product });
  const close = () => setPanel(null);
  const showSaved = (product: Product) => setPanel({ kind: "detail", product });

  let list: ReactNode;
  if (products.isPending) {
    list = <LoadingState label="Loading products" lines={6} />;
  } else if (products.isError) {
    list = <ErrorState title="Couldn’t load the catalog" description={products.error.message} onRetry={() => void products.refetch()} />;
  } else if (products.data.pagination.total === 0) {
    list = isDefault(filters) ? (
      <EmptyState
        title="No products yet"
        description={permissions.canCreate ? "Add your first product or service, or import a list from a spreadsheet." : "Products will appear here once they are added."}
        action={
          permissions.canCreate ? (
            <Button type="button" className="h-11" onClick={() => setPanel({ kind: "create" })}>
              <Plus aria-hidden /> Add product
            </Button>
          ) : undefined
        }
      />
    ) : (
      <EmptyState
        title="No products match"
        description="Try a different search, or clear the filters."
        action={
          <Button type="button" variant="outline" className="h-11" onClick={() => setTyped(DEFAULT_FILTERS)}>
            Clear filters
          </Button>
        }
      />
    );
  } else {
    list = (
      <>
        <ProductTable products={products.data.data} onOpen={open} />
        <ProductCards products={products.data.data} onOpen={open} />
        <Pagination page={page} total={products.data.pagination.total} busy={products.isPlaceholderData} onPage={(next) => setPaging({ key: filterKey, page: next })} />
      </>
    );
  }

  let sheet: ReactNode = null;
  if (panel?.kind === "create") {
    sheet = (
      <Sheet title="Add a product or service" onClose={close}>
        <ProductForm product={null} categories={categoryOptions} canSetTaxClass={permissions.canSetTaxClass} onSaved={showSaved} onCancel={close} />
      </Sheet>
    );
  } else if (panel?.kind === "edit") {
    const editing = panel.product;
    sheet = (
      <Sheet title={`Edit ${editing.name}`} onClose={() => setPanel({ kind: "detail", product: editing })}>
        <ProductForm product={editing} categories={categoryOptions} canSetTaxClass={permissions.canSetTaxClass} onSaved={showSaved} onCancel={() => setPanel({ kind: "detail", product: editing })} />
      </Sheet>
    );
  } else if (panel?.kind === "detail") {
    const shown = panel.product;
    sheet = (
      <Sheet title={shown.name} onClose={close}>
        <ProductDetail product={shown} permissions={permissions} onEdit={() => setPanel({ kind: "edit", product: shown })}>
          <ProductManage product={shown} permissions={permissions} onChanged={showSaved} />
        </ProductDetail>
      </Sheet>
    );
  } else if (panel?.kind === "import") {
    sheet = <ImportSheet onClose={close} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-display text-2xl font-semibold">Products & services</h1>
          <p className="text-sm text-muted-foreground">Everything you sell, with its price and tax class.</p>
        </div>
        {permissions.canCreate || permissions.canImport ? (
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            {permissions.canImport ? (
              <Button type="button" variant="outline" className="h-11" onClick={() => setPanel({ kind: "import" })}>
                <Upload aria-hidden /> Import
              </Button>
            ) : null}
            {permissions.canCreate ? (
              <Button type="button" className="h-11" onClick={() => setPanel({ kind: "create" })}>
                <Plus aria-hidden /> Add product
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <Filters value={typed} onChange={setTyped} categories={categoryOptions} />

      <section aria-label="Catalog" aria-busy={products.isFetching} className={cn("space-y-3", products.isPlaceholderData && "opacity-70")}>
        {list}
      </section>

      {sheet}
    </div>
  );
}
