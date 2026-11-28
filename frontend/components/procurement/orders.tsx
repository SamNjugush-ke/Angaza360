"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { SelectField } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { formatDate } from "@/lib/datetime";
import { formatKES } from "@/lib/money";
import {
  grnName,
  poName,
  procurementKeys,
  STATUS_LABEL,
  STATUSES,
  usePurchaseOrder,
  usePurchaseOrders,
  type GoodsReceipt,
  type ProcurementPermissions,
  type PurchaseOrder,
  type PurchaseOrderStatus,
} from "@/lib/procurement/procurement";
import { StatusBadge } from "./badges";
import { GrnView, OrderDetail, ReceiveGoods } from "./order-detail";
import { OrderForm } from "./order-form";

// Purchase orders, newest first, filtered by status. An order opens in a side sheet that walks
// its lifecycle: the detail, editing a draft, receiving goods, and the goods receipt that results —
// with a way back to the order at each step, and the list kept exactly as it was filtered.

type Panel =
  | { kind: "create" }
  | { kind: "order"; id: string; notice: string | null }
  | { kind: "edit"; order: PurchaseOrder }
  | { kind: "receive"; order: PurchaseOrder }
  | { kind: "grn"; grn: GoodsReceipt; order: PurchaseOrder | null; fresh: boolean };

function OrderPanel({ id, notice, initial, permissions, setPanel }: { id: string; notice: string | null; initial: PurchaseOrder | undefined; permissions: ProcurementPermissions; setPanel: (panel: Panel) => void }) {
  const order = usePurchaseOrder(id, initial);
  if (order.data === undefined) return order.isError ? <ErrorState title="Couldn’t load the order" description={order.error.message} onRetry={() => void order.refetch()} /> : <LoadingState label="Loading the order" />;
  const current = order.data;
  return (
    <OrderDetail
      order={current}
      permissions={permissions}
      notice={notice}
      onEdit={() => setPanel({ kind: "edit", order: current })}
      onReceive={() => setPanel({ kind: "receive", order: current })}
      onOpenGrn={(grn) => setPanel({ kind: "grn", grn, order: current, fresh: false })}
      onChanged={(saved, note) => setPanel({ kind: "order", id: saved.id, notice: note })}
    />
  );
}

function BackTo({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <Button type="button" variant="ghost" className="h-11 px-2" onClick={onClick}>
      <ArrowLeft aria-hidden /> {label}
    </Button>
  );
}

export function OrdersView({ permissions }: { permissions: ProcurementPermissions }) {
  const ids = { status: useId() };
  const client = useQueryClient();
  const [status, setStatus] = useState<PurchaseOrderStatus | "">("");
  const orders = usePurchaseOrders(status);
  const [panel, setPanel] = useState<Panel | null>(null);
  const fromList = (id: string) => orders.data?.data.find((o) => o.id === id);
  const toOrder = (order: PurchaseOrder, notice: string | null = null) => setPanel({ kind: "order", id: order.id, notice });

  let list: ReactNode;
  if (orders.isPending) list = <LoadingState label="Loading purchase orders" lines={5} />;
  else if (orders.isError) list = <ErrorState title="Couldn’t load purchase orders" description={orders.error.message} onRetry={() => void orders.refetch()} />;
  else if (orders.data.data.length === 0)
    list =
      status === "" ? (
        <EmptyState
          title="No purchase orders yet"
          description={permissions.canRaise ? "Raise an order to a supplier; stock arrives against it." : "Orders raised by the owner or manager appear here."}
          action={
            permissions.canRaise ? (
              <Button type="button" className="h-11" onClick={() => setPanel({ kind: "create" })}>
                <Plus aria-hidden /> Raise purchase order
              </Button>
            ) : undefined
          }
        />
      ) : (
        <EmptyState
          title={`No ${STATUS_LABEL[status].toLowerCase()} orders`}
          description="Try another status."
          action={
            <Button type="button" variant="outline" className="h-11" onClick={() => setStatus("")}>
              Show all orders
            </Button>
          }
        />
      );
  else
    list = (
      <>
        <table className="hidden w-full text-sm md:table">
          <caption className="sr-only">Purchase orders</caption>
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th scope="col" className="py-2 pr-4 font-medium">Order</th>
              <th scope="col" className="py-2 pr-4 font-medium">Supplier</th>
              <th scope="col" className="py-2 pr-4 font-medium">Ordered</th>
              <th scope="col" className="py-2 pr-4 font-medium">Expected</th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">Total (KES)</th>
              <th scope="col" className="py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {orders.data.data.map((o) => (
              <tr key={o.id} className="border-b last:border-b-0">
                <td className="py-1 pr-4">
                  <button type="button" onClick={() => toOrder(o)} className="min-h-11 rounded-sm text-left font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {poName(o)}
                  </button>
                </td>
                <td className="py-1 pr-4">{o.supplierName}</td>
                <td className="py-1 pr-4">{formatDate(o.orderDate)}</td>
                <td className="py-1 pr-4">{o.expectedDate ? formatDate(o.expectedDate) : "—"}</td>
                <td className="py-1 pr-4 text-right tabular-nums">{formatKES(o.subtotal)}</td>
                <td className="py-1">
                  <StatusBadge status={o.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="space-y-2 md:hidden" aria-label="Purchase orders">
          {orders.data.data.map((o) => (
            <li key={o.id}>
              <button type="button" onClick={() => toOrder(o)} className="flex min-h-11 w-full flex-col gap-1 rounded-lg border p-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="flex w-full justify-between gap-3">
                  <span className="font-medium">{poName(o)}</span>
                  <span className="tabular-nums">KES {formatKES(o.subtotal)}</span>
                </span>
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <StatusBadge status={o.status} /> {o.supplierName} · {formatDate(o.orderDate)}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {orders.data.count === 1 ? "1 order" : `${orders.data.count.toString()} orders`}
        </p>
      </>
    );

  let sheet: ReactNode = null;
  if (panel?.kind === "create") {
    sheet = (
      <Sheet key="create" title="Raise a purchase order" onClose={() => setPanel(null)} wide>
        <OrderForm order={null} permissions={permissions} onSaved={(o) => {
          void client.invalidateQueries({ queryKey: procurementKeys.all });
          toOrder(o, `${poName(o)} saved as a draft. Approve it to send it to the supplier.`);
        }} />
      </Sheet>
    );
  } else if (panel?.kind === "order") {
    const initial = fromList(panel.id);
    sheet = (
      <Sheet key={`order-${panel.id}-${panel.notice ?? ""}`} title={initial ? poName(initial) : "Purchase order"} onClose={() => setPanel(null)} wide>
        <OrderPanel id={panel.id} notice={panel.notice} initial={initial} permissions={permissions} setPanel={setPanel} />
      </Sheet>
    );
  } else if (panel?.kind === "edit") {
    const order = panel.order;
    sheet = (
      <Sheet key="edit" title={`Edit ${poName(order)}`} onClose={() => toOrder(order)} wide>
        <BackTo label={`Back to ${poName(order)}`} onClick={() => toOrder(order)} />
        <OrderForm order={order} permissions={permissions} onSaved={(o) => {
          void client.invalidateQueries({ queryKey: procurementKeys.all });
          toOrder(o, "The draft was saved.");
        }} />
      </Sheet>
    );
  } else if (panel?.kind === "receive") {
    const order = panel.order;
    sheet = (
      <Sheet key="receive" title={`Receive goods — ${poName(order)}`} onClose={() => toOrder(order)} wide>
        <BackTo label={`Back to ${poName(order)}`} onClick={() => toOrder(order)} />
        <ReceiveGoods order={order} onReceived={(grn) => setPanel({ kind: "grn", grn, order, fresh: true })} />
      </Sheet>
    );
  } else if (panel?.kind === "grn") {
    const { grn, order } = panel;
    sheet = (
      <Sheet key={`grn-${grn.id}`} title={grnName(grn)} onClose={() => (order ? toOrder(order) : setPanel(null))} wide>
        {panel.fresh ? (
          <p role="status" className="mb-3 rounded-md border border-emerald-700/40 bg-emerald-700/10 px-3 py-2 text-sm">
            Goods received — {grnName(grn)}. The stock is in and what is owed to the supplier is recorded.
          </p>
        ) : null}
        {order ? <BackTo label={`Back to ${poName(order)}`} onClick={() => toOrder(order)} /> : null}
        <GrnView grn={grn} order={order} canReadLedger={permissions.canReadLedger} />
      </Sheet>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="w-full max-w-xs">
          <SelectField id={ids.status} label="Status" value={status} onChange={(v) => setStatus(v as PurchaseOrderStatus | "")}>
            <option value="">All orders</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </SelectField>
        </div>
        {permissions.canRaise ? (
          <Button type="button" className="h-11" onClick={() => setPanel({ kind: "create" })}>
            <Plus aria-hidden /> Raise purchase order
          </Button>
        ) : null}
      </div>
      <section aria-label="Purchase order list" aria-busy={orders.isFetching} className="space-y-3">
        {list}
      </section>
      {sheet}
    </div>
  );
}
