"use client";

import { Search } from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";
import { useWorkingLocation } from "@/components/shell/location";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { SelectField } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet } from "@/components/ui/sheet";
import { formatDateTime } from "@/lib/datetime";
import {
  MOVEMENT_LABEL,
  MOVEMENTS_PAGE,
  signedQuantity,
  useLocationStock,
  useMovements,
  useSplit,
  useStock,
  type StockPermissions,
} from "@/lib/inventory/inventory";
import { formatKES } from "@/lib/money";
import { displayQuantity, isQuantity, toMilli } from "@/lib/pos/quantity";
import { cn } from "@/lib/utils";
import { ACTION_TITLE, AdjustForm, ReceiveForm, TransferForm, WriteOffForm, type StockAction } from "./stock-forms";

// The stock list. "All locations" reads the business-wide levels (GET /stock), where "Needs
// reordering" is the server's rule (an active good with a reorder level above 0, at or below it);
// a single location reads what that location owns (GET /stock/by-location), including any frozen
// part. The API pages neither, so the search runs over the rows on screen. A product opens its
// split across locations and its movement history, with the role's stock actions.

interface Row {
  productId: string;
  name: string;
  sku: string;
  unit: string | null;
  quantity: string;
  detail: ReactNode;
  value: string | null;
  reorder: boolean;
}

const positive = (quantity: string) => isQuantity(quantity) && toMilli(quantity) > 0n;

const BADGE = "inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium";

function ReorderBadge() {
  return <span className={cn(BADGE, "border-amber-500/50 bg-amber-500/10 text-foreground")}>Reorder</span>;
}

function Movements({ productId }: { productId: string }) {
  const [page, setPage] = useState(0);
  const place = useWorkingLocation();
  const movements = useMovements(productId, page);
  const nameOf = (id: string | null) => (id === null ? (place?.locations.find((l) => l.isDefault)?.name ?? "Main") : (place?.locations.find((l) => l.id === id)?.name ?? "Another location"));
  if (movements.isPending) return <LoadingState label="Loading the history" />;
  if (movements.isError) return <ErrorState title="Couldn’t load the history" description={movements.error.message} onRetry={() => void movements.refetch()} />;
  const { rows, pagination } = movements.data;
  if (pagination.total === 0) return <p className="text-sm text-muted-foreground">No movements yet.</p>;
  const lastPage = Math.max(0, Math.ceil(pagination.total / MOVEMENTS_PAGE) - 1);
  return (
    <div className="space-y-2">
      <ul aria-label="Movements" className="divide-y rounded-lg border text-sm">
        {rows.map((m) => (
          <li key={m.id} className="space-y-0.5 px-3 py-2">
            <p className="flex justify-between gap-3">
              <span className="font-medium">{MOVEMENT_LABEL[m.movementType]}</span>
              <span className="tabular-nums">{signedQuantity(m.movementType, displayQuantity(m.quantity))}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {formatDateTime(m.createdAt)} · {nameOf(m.locationId)} · total after {displayQuantity(m.balanceQty)}
              {m.reference ? ` · ${m.reference}` : ""}
              {m.notes ? ` · ${m.notes}` : ""}
            </p>
          </li>
        ))}
      </ul>
      <nav aria-label="History pages" className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {`${(page * MOVEMENTS_PAGE + 1).toString()}–${Math.min(pagination.total, (page + 1) * MOVEMENTS_PAGE).toString()} of ${pagination.total.toString()}`}
        </p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" className="h-11" disabled={page === 0} onClick={() => setPage(page - 1)}>
            Newer
          </Button>
          <Button type="button" variant="outline" className="h-11" disabled={page >= lastPage} onClick={() => setPage(page + 1)}>
            Older
          </Button>
        </div>
      </nav>
    </div>
  );
}

function StockDetail({ product, permissions, onAction }: { product: { productId: string; name: string; sku: string }; permissions: StockPermissions; onAction: (action: StockAction) => void }) {
  const split = useSplit(product.productId);
  const actions: StockAction[] = permissions.canMoveStock ? ["receive", "adjust", "transfer", ...(permissions.canWriteOff ? (["writeoff"] as const) : [])] : [];
  return (
    <div className="space-y-5">
      {actions.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {actions.map((action, index) => (
            <Button key={action} type="button" variant={index === 0 ? "default" : "outline"} className="h-11" onClick={() => onAction(action)} data-autofocus={index === 0 ? true : undefined}>
              {ACTION_TITLE[action]}
            </Button>
          ))}
        </div>
      ) : null}
      <section aria-labelledby="split-heading" className="space-y-2">
        <h3 id="split-heading" className="font-medium">
          Where it is
        </h3>
        {split.isPending ? (
          <LoadingState label="Loading where it is held" lines={2} />
        ) : split.isError ? (
          <ErrorState title="Couldn’t load the locations" description={split.error.message} onRetry={() => void split.refetch()} />
        ) : (
          <>
            <table className="w-full text-sm">
              <caption className="sr-only">Stock by location</caption>
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th scope="col" className="py-1 pr-3 font-medium">Location</th>
                  <th scope="col" className="py-1 pr-3 text-right font-medium">Quantity</th>
                  <th scope="col" className="py-1 text-right font-medium">Value (KES)</th>
                </tr>
              </thead>
              <tbody>
                {split.data.locations.map((l) => (
                  <tr key={l.locationId} className="border-b last:border-b-0">
                    <td className="py-1.5 pr-3">{l.locationName}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{displayQuantity(l.quantity)}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatKES(l.value)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <th scope="row" className="py-1.5 pr-3 text-left">All locations</th>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{displayQuantity(split.data.aggregateStockCount)}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatKES(split.data.stockValue)}</td>
                </tr>
              </tfoot>
            </table>
            {!split.data.matches || !split.data.valueMatches ? (
              <p role="alert" className="text-sm text-destructive">
                The locations do not add up to the business-wide figure. Please report this — nothing needs to be done at the till.
              </p>
            ) : null}
          </>
        )}
      </section>
      <section aria-labelledby="history-heading" className="space-y-2">
        <h3 id="history-heading" className="font-medium">
          History
        </h3>
        <Movements productId={product.productId} />
      </section>
    </div>
  );
}

function ActionSheet({ action, product, permissions, onClose }: { action: StockAction; product: { productId: string; name: string; sku: string; unit: string; costPrice: string } | null; permissions: StockPermissions; onClose: () => void }) {
  const picked = product ? { id: product.productId, name: product.name, sku: product.sku, unitOfMeasure: product.unit, costPrice: product.costPrice } : null;
  return (
    <Sheet title={product ? `${ACTION_TITLE[action]} — ${product.name}` : ACTION_TITLE[action]} onClose={onClose}>
      {action === "receive" ? <ReceiveForm product={picked} canPickSupplier={permissions.canUseSuppliers} /> : null}
      {action === "adjust" ? <AdjustForm product={picked} /> : null}
      {action === "writeoff" ? <WriteOffForm product={picked} /> : null}
      {action === "transfer" ? <TransferForm product={picked} /> : null}
    </Sheet>
  );
}

export function StockView({ permissions }: { permissions: StockPermissions }) {
  const ids = { search: useId(), location: useId(), reorder: useId() };
  const place = useWorkingLocation();
  const [search, setSearch] = useState("");
  const [locationId, setLocationId] = useState("");
  const [reorder, setReorder] = useState(false);
  const [open, setOpen] = useState<{ productId: string; name: string; sku: string; unit: string; costPrice: string } | null>(null);
  const [action, setAction] = useState<{ kind: StockAction; withProduct: boolean } | null>(null);

  const byLocation = locationId !== "" && !reorder;
  const stock = useStock(reorder, !byLocation);
  const slice = useLocationStock(byLocation ? locationId : null);
  const query = byLocation ? slice : stock;

  const rows: Row[] = useMemo(() => {
    if (byLocation) {
      return (slice.data?.data ?? []).map((r) => ({
        productId: r.productId,
        name: r.name,
        sku: r.sku,
        unit: null,
        quantity: r.quantity,
        detail: positive(r.frozenQuantity) ? `${displayQuantity(r.sellableQuantity)} sellable · ${displayQuantity(r.frozenQuantity)} frozen` : null,
        value: r.value,
        reorder: false,
      }));
    }
    return (stock.data?.data ?? []).map((r) => ({
      productId: r.productId,
      name: r.name,
      sku: r.sku,
      unit: r.unitOfMeasure,
      quantity: r.stockCount,
      detail: positive(r.minStockThreshold) ? `reorder at ${displayQuantity(r.minStockThreshold)}` : null,
      value: r.stockValue,
      reorder: r.belowReorder,
    }));
  }, [byLocation, slice.data, stock.data]);

  const needle = search.trim().toLowerCase();
  const shown = needle === "" ? rows : rows.filter((r) => r.name.toLowerCase().includes(needle) || r.sku.toLowerCase().includes(needle));
  const costOf = (productId: string) => stock.data?.data.find((r) => r.productId === productId)?.avgCost ?? "0";
  const openRow = (r: Row) => setOpen({ productId: r.productId, name: r.name, sku: r.sku, unit: r.unit ?? "units", costPrice: costOf(r.productId) });

  let list: ReactNode;
  if (query.isPending) list = <LoadingState label="Loading stock" lines={6} />;
  else if (query.isError) list = <ErrorState title="Couldn’t load stock" description={query.error.message} onRetry={() => void query.refetch()} />;
  else if (rows.length === 0)
    list = reorder ? (
      <EmptyState title="Nothing needs reordering" description="Every product with a reorder level is above it." />
    ) : (
      <EmptyState title={byLocation ? "This location holds no stock" : "No stock yet"} description={byLocation ? "Transfer stock here, or receive into the main store." : "Receive stock to see it here."} />
    );
  else if (shown.length === 0)
    list = (
      <EmptyState
        title="No products match"
        description={`Nothing here matches “${search.trim()}”.`}
        action={
          <Button type="button" variant="outline" className="h-11" onClick={() => setSearch("")}>
            Clear the search
          </Button>
        }
      />
    );
  else
    list = (
      <>
        <table className="hidden w-full text-sm md:table">
          <caption className="sr-only">Stock</caption>
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th scope="col" className="py-2 pr-4 font-medium">Product</th>
              <th scope="col" className="py-2 pr-4 font-medium">SKU</th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">On hand</th>
              <th scope="col" className="py-2 pr-4 font-medium">Notes</th>
              <th scope="col" className="py-2 text-right font-medium">Value (KES)</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.productId} className="border-b last:border-b-0">
                <td className="py-1 pr-4">
                  <button type="button" onClick={() => openRow(r)} className="min-h-11 rounded-sm text-left font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {r.name}
                  </button>
                </td>
                <td className="py-1 pr-4 font-mono text-xs">{r.sku}</td>
                <td className="py-1 pr-4 text-right tabular-nums">
                  {displayQuantity(r.quantity)}
                  {r.unit ? <span className="text-muted-foreground"> {r.unit}</span> : null}
                </td>
                <td className="py-1 pr-4">
                  <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {r.reorder ? <ReorderBadge /> : null}
                    {r.detail}
                  </span>
                </td>
                <td className="py-1 text-right tabular-nums">{r.value === null ? "—" : formatKES(r.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="space-y-2 md:hidden" aria-label="Stock">
          {shown.map((r) => (
            <li key={r.productId}>
              <button type="button" onClick={() => openRow(r)} className="flex min-h-11 w-full flex-col gap-1 rounded-lg border p-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="flex w-full justify-between gap-3">
                  <span className="font-medium">{r.name}</span>
                  <span className="tabular-nums">
                    {displayQuantity(r.quantity)} {r.unit ?? ""}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono">{r.sku}</span>
                  {r.reorder ? <ReorderBadge /> : null}
                  {r.detail}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {shown.length === rows.length ? `${rows.length.toString()} products` : `${shown.length.toString()} of ${rows.length.toString()} products`}
        </p>
      </>
    );

  return (
    <div className="space-y-4">
      {permissions.canMoveStock ? (
        <div className="flex flex-wrap gap-2">
          {(["receive", "adjust", "transfer", ...(permissions.canWriteOff ? (["writeoff"] as const) : [])] as StockAction[]).map((kind, index) => (
            <Button key={kind} type="button" variant={index === 0 ? "default" : "outline"} className="h-11" onClick={() => setAction({ kind, withProduct: false })}>
              {ACTION_TITLE[kind]}
            </Button>
          ))}
        </div>
      ) : null}
      <div role="search" aria-label="Filter stock" className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor={ids.search}>Search</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input id={ids.search} type="search" className="h-11 pl-9" placeholder="Name or SKU" autoComplete="off" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        <SelectField id={ids.location} label="Location" value={reorder ? "" : locationId} onChange={setLocationId} disabled={reorder} hint={reorder ? "Reordering is judged on the business-wide total." : undefined}>
          <option value="">All locations</option>
          {(place?.locations ?? []).map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </SelectField>
        <label htmlFor={ids.reorder} className="flex min-h-11 items-center gap-3 self-end text-sm font-medium">
          <input id={ids.reorder} type="checkbox" className="size-5" checked={reorder} onChange={(e) => setReorder(e.target.checked)} />
          Needs reordering
        </label>
      </div>
      <section aria-label="Stock list" aria-busy={query.isFetching} className="space-y-3">
        {list}
      </section>

      {open && action === null ? (
        <Sheet title={open.name} onClose={() => setOpen(null)} wide>
          <StockDetail product={open} permissions={permissions} onAction={(kind) => setAction({ kind, withProduct: true })} />
        </Sheet>
      ) : null}
      {action ? <ActionSheet action={action.kind} product={action.withProduct ? open : null} permissions={permissions} onClose={() => setAction(null)} /> : null}
    </div>
  );
}
