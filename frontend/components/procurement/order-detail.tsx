"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";
import { FormAlert, TextField } from "@/components/auth/form-bits";
import { useWorkingLocation } from "@/components/shell/location";
import { ErrorState, LoadingState } from "@/components/states/states";
import { quantityProblem, SelectField } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { businessToday, formatDate } from "@/lib/datetime";
import { formatKES } from "@/lib/money";
import { displayQuantity, isQuantity, toMilli } from "@/lib/pos/quantity";
import {
  decidePurchaseOrder,
  grnName,
  outstanding,
  poName,
  receivePurchaseOrder,
  STATUS_LABEL,
  STEPS,
  useGoodsReceipt,
  useInvalidateProcurement,
  useJournalEntries,
  useOrderReceipts,
  type GoodsReceipt,
  type ProcurementPermissions,
  type PurchaseOrder,
} from "@/lib/procurement/procurement";
import { StatusBadge } from "./badges";

// One purchase order: its lines — ordered, received, still to come — and the lifecycle steps its
// status and the role allow. Approving commits to the supplier; receiving creates a goods receipt
// (GRN) that moves the stock in and accrues what is owed; a partly received order can be closed
// short; only an order nothing has arrived on can be cancelled. Every step asks first.

type Decision = "approve" | "cancel" | "close";
const DECISION: Readonly<Record<Decision, { button: string; question: string; body: string; done: string }>> = {
  approve: { button: "Approve", question: "Approve this order?", body: "The supplier can be sent it, and its terms are then fixed.", done: "approved" },
  cancel: { button: "Cancel order", question: "Cancel this order?", body: "Nothing has arrived on it, so it simply stops. This cannot be undone.", done: "cancelled" },
  close: { button: "Close order", question: "Close this order?", body: "Nothing more will be received on it, even if lines are still short. This cannot be undone.", done: "closed" },
};

function Decide({ order, decision, onDone }: { order: PurchaseOrder; decision: Decision; onDone: (order: PurchaseOrder, note: string) => void }) {
  const ids = { title: useId(), body: useId() };
  const invalidate = useInvalidateProcurement();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const text = DECISION[decision];
  async function confirm() {
    setSaving(true);
    setError(null);
    try {
      const saved = await decidePurchaseOrder(order.id, decision);
      await invalidate();
      setAsking(false);
      onDone(saved, `${poName(saved)} ${text.done}.`);
    } catch (failure) {
      setError(failure instanceof ApiHttpError ? failure.message : "That could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  }
  if (!asking) {
    return (
      <Button type="button" variant={decision === "approve" ? "default" : "outline"} className="h-11" onClick={() => setAsking(true)}>
        {text.button}
      </Button>
    );
  }
  return (
    <div role="alertdialog" aria-labelledby={ids.title} aria-describedby={ids.body} className="w-full space-y-2 rounded-md border p-3">
      <p id={ids.title} className="font-medium">
        {text.question}
      </p>
      <p id={ids.body} className="text-sm">
        {text.body}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button type="button" variant="outline" className="h-11" onClick={() => setAsking(false)} disabled={saving} data-autofocus>
          Back
        </Button>
        <Button type="button" className="h-11" onClick={() => void confirm()} disabled={saving}>
          {saving ? "Saving…" : `Yes, ${text.button.toLowerCase()}`}
        </Button>
      </div>
    </div>
  );
}

export function ReceiveGoods({ order, onReceived }: { order: PurchaseOrder; onReceived: (grn: GoodsReceipt) => void }) {
  const ids = { location: useId(), date: useId(), notes: useId(), error: useId() };
  const place = useWorkingLocation();
  const invalidate = useInvalidateProcurement();
  const [today] = useState(() => businessToday());
  const open = order.lines.filter((l) => toMilli(outstanding(l)) > 0n);
  const [quantities, setQuantities] = useState<Record<string, string>>(() => Object.fromEntries(open.map((l) => [l.id, displayQuantity(outstanding(l))])));
  const [locationId, setLocationId] = useState(place?.locations.find((l) => l.isDefault)?.id ?? "");
  const [receivedAt, setReceivedAt] = useState(today);
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found: Record<string, string> = {};
    const lines: Array<{ purchaseOrderLineId: string; quantity: string }> = [];
    for (const line of open) {
      const typed = (quantities[line.id] ?? "").trim();
      if (typed === "" || (isQuantity(typed) && toMilli(typed) === 0n)) continue;
      const problem = quantityProblem(typed);
      if (problem) found[line.id] = problem;
      else if (toMilli(typed) > toMilli(outstanding(line))) found[line.id] = `Only ${displayQuantity(outstanding(line))} is still to come on this line.`;
      else lines.push({ purchaseOrderLineId: line.id, quantity: typed });
    }
    if (Object.keys(found).length === 0 && lines.length === 0) found.none = "Enter what arrived on at least one line.";
    if (receivedAt > today) found.date = "Goods cannot arrive in the future.";
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    setError(null);
    try {
      const grn = await receivePurchaseOrder(order.id, { lines, ...(locationId ? { receivingLocationId: locationId } : {}), receivedAt, ...(notes.trim() ? { notes: notes.trim() } : {}) });
      await invalidate();
      onReceived(grn);
    } catch (failure) {
      setError(failure instanceof ApiHttpError ? failure.message : "The goods could not be received. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="space-y-4">
      {error ? <FormAlert id={ids.error}>{error}</FormAlert> : null}
      <p className="text-sm text-muted-foreground">Enter what actually arrived. Leave a line at 0 if none of it came; you can receive the rest later.</p>
      <ul aria-label="Lines to receive" className="space-y-2">
        {open.map((line) => (
          <li key={line.id} className="rounded-lg border p-3">
            <TextField
              id={`recv-${line.id}`}
              label={`${line.productName} received`}
              hint={`${displayQuantity(line.receivedQty)} of ${displayQuantity(line.orderedQty)} already in; ${displayQuantity(outstanding(line))} to come.`}
              inputMode="decimal"
              autoComplete="off"
              value={quantities[line.id] ?? ""}
              error={errors[line.id]}
              onChange={(e) => setQuantities({ ...quantities, [line.id]: e.target.value })}
            />
          </li>
        ))}
      </ul>
      {errors.none ? (
        <p role="alert" className="text-sm text-destructive">
          {errors.none}
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField id={ids.location} label="Received into" value={locationId} onChange={setLocationId}>
          {(place?.locations ?? []).map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </SelectField>
        <TextField id={ids.date} label="Date received" type="date" max={today} value={receivedAt} error={errors.date} onChange={(e) => setReceivedAt(e.target.value)} />
      </div>
      <TextField id={ids.notes} label="Notes" optional placeholder="e.g. delivery note no." autoComplete="off" value={notes} onChange={(e) => setNotes(e.target.value)} />
      <Button type="submit" className="h-11" disabled={saving}>
        {saving ? "Receiving…" : "Receive the goods"}
      </Button>
    </form>
  );
}

function Postings({ grn, canReadLedger }: { grn: GoodsReceipt; canReadLedger: boolean }) {
  const entryIds = [...new Set(grn.lines.map((l) => l.journalEntryId).filter((id): id is string => id !== null))];
  const entries = useJournalEntries(entryIds, canReadLedger);
  if (entryIds.length === 0) return <p className="text-sm text-muted-foreground">Nothing was posted to the books for this receipt.</p>;
  if (!canReadLedger) return <p className="text-sm text-muted-foreground">Posted to the books. Your role does not open ledger entries; an owner, manager or accountant can.</p>;
  return (
    <div className="space-y-3">
      {entries.map((entry, index) =>
        entry.isPending ? (
          <LoadingState key={entryIds[index]} label="Loading the postings" lines={2} />
        ) : entry.isError ? (
          <ErrorState key={entryIds[index]} title="Couldn’t load the postings" description={entry.error.message} onRetry={() => void entry.refetch()} />
        ) : (
          <table key={entry.data.id} className="w-full text-sm">
            <caption className="text-left text-xs text-muted-foreground">
              Entry {entry.data.entryNumber} · {formatDate(entry.data.entryDate)}
            </caption>
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th scope="col" className="py-1 pr-3 font-medium">Account</th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">Debit (KES)</th>
                <th scope="col" className="py-1 text-right font-medium">Credit (KES)</th>
              </tr>
            </thead>
            <tbody>
              {entry.data.lines.map((line) => (
                <tr key={line.id} className="border-b last:border-b-0">
                  <td className="py-1.5 pr-3">
                    {line.account.code} {line.account.name}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{line.debit === "0" ? "" : formatKES(line.debit)}</td>
                  <td className="py-1.5 text-right tabular-nums">{line.credit === "0" ? "" : formatKES(line.credit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ),
      )}
    </div>
  );
}

export function GrnView({ grn, order, canReadLedger }: { grn: GoodsReceipt; order: PurchaseOrder | null; canReadLedger: boolean }) {
  const place = useWorkingLocation();
  const location = place?.locations.find((l) => l.id === grn.receivingLocationId)?.name ?? grn.receivingLocationCode;
  return (
    <div className="space-y-4">
      <dl className="text-sm">
        {[
          ["Order", `${poName(grn)}${order ? ` · ${order.supplierName}` : ""}`],
          ["Received into", location],
          ["Date received", formatDate(grn.receivedAt)],
          ["Order now", STATUS_LABEL[grn.purchaseOrderStatus]],
          ...(grn.notes ? [["Notes", grn.notes]] : []),
        ].map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4 border-b py-1.5 last:border-b-0">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right">{value}</dd>
          </div>
        ))}
      </dl>
      <table className="w-full text-sm">
        <caption className="sr-only">Goods received</caption>
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th scope="col" className="py-1 pr-3 font-medium">Product</th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">Received</th>
            <th scope="col" className="py-1 text-right font-medium">Cost (KES)</th>
          </tr>
        </thead>
        <tbody>
          {grn.lines.map((line) => {
            const name = order?.lines.find((l) => l.id === line.purchaseOrderLineId)?.productName;
            return (
              <tr key={line.stockMovementId} className="border-b last:border-b-0">
                <td className="py-1.5 pr-3">
                  {name ?? line.sku} <span className="font-mono text-xs text-muted-foreground">{line.sku}</span>
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{displayQuantity(line.quantity)}</td>
                <td className="py-1.5 text-right tabular-nums">{formatKES(line.totalCost)}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="font-semibold">
            <th scope="row" colSpan={2} className="py-1.5 pr-3 text-left">
              Owed to the supplier for these goods
            </th>
            <td className="py-1.5 text-right tabular-nums">{formatKES(grn.totalAccrued)}</td>
          </tr>
        </tfoot>
      </table>
      <section aria-labelledby="grn-postings" className="space-y-2">
        <h3 id="grn-postings" className="font-medium">
          Posted to the books
        </h3>
        <Postings grn={grn} canReadLedger={canReadLedger} />
      </section>
    </div>
  );
}

function ReceiptLink({ id, onOpen }: { id: string; onOpen: (grn: GoodsReceipt) => void }) {
  const grn = useGoodsReceipt(id);
  if (!grn.data) return <li className="px-3 py-2 text-sm text-muted-foreground">Loading a receipt…</li>;
  const data = grn.data;
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(data)}
        className="flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="font-medium">{grnName(data)}</span>
        <span className="text-muted-foreground">
          {formatDate(data.receivedAt)} · KES {formatKES(data.totalAccrued)}
        </span>
      </button>
    </li>
  );
}

export function OrderDetail({
  order,
  permissions,
  notice,
  onEdit,
  onReceive,
  onOpenGrn,
  onChanged,
}: {
  order: PurchaseOrder;
  permissions: ProcurementPermissions;
  notice: string | null;
  onEdit: () => void;
  onReceive: () => void;
  onOpenGrn: (grn: GoodsReceipt) => void;
  onChanged: (order: PurchaseOrder, note: string) => void;
}) {
  const steps = STEPS[order.status];
  const received = order.status !== "DRAFT" && order.status !== "APPROVED" && order.status !== "CANCELLED";
  const receipts = useOrderReceipts(order, received);
  const actions: ReactNode[] = [];
  if (steps.receive && permissions.canReceive)
    actions.push(
      <Button key="receive" type="button" className="h-11" onClick={onReceive} data-autofocus>
        Receive goods
      </Button>,
    );
  if (steps.edit && permissions.canEditDraft)
    actions.push(
      <Button key="edit" type="button" variant="outline" className="h-11" onClick={onEdit}>
        Edit the draft
      </Button>,
    );
  if (permissions.canDecide) {
    for (const decision of ["approve", "close", "cancel"] as const) if (steps[decision]) actions.push(<Decide key={decision} order={order} decision={decision} onDone={onChanged} />);
  }

  return (
    <div className="space-y-5">
      {notice ? (
        <p role="status" className="rounded-md border border-emerald-700/40 bg-emerald-700/10 px-3 py-2 text-sm">
          {notice}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge status={order.status} />
        <span className="text-sm text-muted-foreground">
          {order.supplierName} · ordered {formatDate(order.orderDate)}
          {order.expectedDate ? ` · expected ${formatDate(order.expectedDate)}` : ""}
        </span>
      </div>
      {actions.length > 0 ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      <section aria-labelledby="po-lines" className="space-y-2">
        <h3 id="po-lines" className="font-medium">
          Lines
        </h3>
        <div className="overflow-x-auto" role="region" aria-label="Order lines, scrollable" tabIndex={0}>
          <table className="w-full min-w-[36rem] text-sm">
            <caption className="sr-only">Ordered and received</caption>
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th scope="col" className="py-1 pr-3 font-medium">Product</th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">Ordered</th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">Received</th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">To come</th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">Unit cost</th>
                <th scope="col" className="py-1 text-right font-medium">Line (KES)</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((line) => (
                <tr key={line.id} className="border-b last:border-b-0">
                  <td className="py-1.5 pr-3">
                    {line.productName} <span className="font-mono text-xs text-muted-foreground">{line.sku}</span>
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{displayQuantity(line.orderedQty)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{displayQuantity(line.receivedQty)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{displayQuantity(outstanding(line))}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{formatKES(line.unitCost)}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatKES(line.lineNet)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <th scope="row" colSpan={5} className="py-1.5 pr-3 text-left">
                  Order total
                </th>
                <td className="py-1.5 text-right tabular-nums">{formatKES(order.subtotal)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
      {order.notes ? <p className="text-sm">Notes: {order.notes}</p> : null}
      {received ? (
        <section aria-labelledby="po-receipts" className="space-y-2">
          <h3 id="po-receipts" className="font-medium">
            Goods receipts
          </h3>
          {receipts.isPending ? (
            <LoadingState label="Finding the goods receipts" lines={2} />
          ) : receipts.isError ? (
            <ErrorState title="Couldn’t find the goods receipts" description={receipts.error.message} onRetry={() => void receipts.refetch()} />
          ) : receipts.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">No goods receipts found.</p>
          ) : (
            <ul aria-label="Goods receipts" className="divide-y rounded-lg border">
              {receipts.data.map((id) => (
                <ReceiptLink key={id} id={id} onOpen={onOpenGrn} />
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
