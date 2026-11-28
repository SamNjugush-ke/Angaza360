"use client";

import { ArrowLeft, Plus } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { TextField } from "@/components/auth/form-bits";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { SelectField } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { formatDate } from "@/lib/datetime";
import { formatKES, parseCents } from "@/lib/money";
import {
  BILL_STATUS_LABEL,
  BILL_STATUSES,
  cancelBill,
  isOpenBill,
  postBill,
  useBill,
  useBills,
  useInvalidatePayables,
  type Bill,
  type BillStatus,
  type PayablesPermissions,
} from "@/lib/payables/payables";
import { displayQuantity } from "@/lib/pos/quantity";
import { cn } from "@/lib/utils";
import { BillForm } from "./bill-form";
import { PaymentForm } from "./payments";

// Supplier bills: a DRAFT is checked and edited, then POSTED — which books what is owed, recognises
// input VAT, and for a line matched to received goods clears what those goods accrued in GRNI, with
// any price difference shown as a variance. An unpaid posted bill can be cancelled (a reversing
// entry); one with payments against it cannot. Every step asks first.

const TONE: Readonly<Record<BillStatus, string>> = {
  DRAFT: "bg-muted",
  AWAITING_PAYMENT: "border-amber-500/50 bg-amber-500/10",
  PARTIALLY_PAID: "border-primary/40 bg-primary/10",
  PAID: "border-emerald-700/40 bg-emerald-700/10",
  CANCELLED: "border-destructive/40 bg-destructive/10",
};

export function BillStatusBadge({ status }: { status: BillStatus }) {
  return <span className={cn("inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium text-foreground", TONE[status])}>{BILL_STATUS_LABEL[status]}</span>;
}

/** What is still owed on a posted bill: total − paid, in cents (for allocating a payment). */
export const owedOn = (bill: Pick<Bill, "total" | "amountPaid">) => (parseCents(bill.total) - parseCents(bill.amountPaid)).toString();

function Step({ label, question, body, needsReason, run, onDone }: { label: string; question: string; body: string; needsReason: boolean; run: (reason: string) => Promise<Bill>; onDone: (bill: Bill) => void }) {
  const ids = { title: useId(), reason: useId() };
  const invalidate = useInvalidatePayables();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (!asking) {
    return (
      <Button type="button" variant={needsReason ? "outline" : "default"} className="h-11" onClick={() => setAsking(true)}>
        {label}
      </Button>
    );
  }
  async function confirm() {
    if (needsReason && reason.trim() === "") {
      setProblem("Give a reason — it is kept with the bill.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await run(reason.trim());
      await invalidate();
      setAsking(false);
      onDone(saved);
    } catch (failure) {
      setError(failure instanceof ApiHttpError ? failure.message : "That could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div role="alertdialog" aria-labelledby={ids.title} className="w-full space-y-2 rounded-md border p-3">
      <p id={ids.title} className="font-medium">
        {question}
      </p>
      <p className="text-sm">{body}</p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {needsReason ? <TextField id={ids.reason} label="Reason" autoComplete="off" value={reason} error={problem ?? undefined} onChange={(e) => setReason(e.target.value)} data-autofocus /> : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button type="button" variant="outline" className="h-11" onClick={() => setAsking(false)} disabled={saving} data-autofocus={needsReason ? undefined : true}>
          Back
        </Button>
        <Button type="button" className="h-11" onClick={() => void confirm()} disabled={saving}>
          {saving ? "Saving…" : `Yes, ${label.toLowerCase()}`}
        </Button>
      </div>
    </div>
  );
}

export function BillDetail({ bill, permissions, notice, onEdit, onPay, onChanged }: { bill: Bill; permissions: PayablesPermissions; notice: string | null; onEdit: () => void; onPay: () => void; onChanged: (bill: Bill, note: string) => void }) {
  const posted = bill.status !== "DRAFT" && bill.status !== "CANCELLED";
  const actions: ReactNode[] = [];
  if (permissions.canEnterBills && bill.status === "DRAFT") {
    actions.push(
      <Step key="post" label="Post bill" question="Post this bill to the books?" body="It becomes owed to the supplier, and matched lines clear what the goods accrued. A posted bill can no longer be edited." needsReason={false} run={() => postBill(bill.id)} onDone={(b) => onChanged(b, `Bill ${b.billNumber} posted — KES ${formatKES(b.total)} owed to ${b.supplierName}.`)} />,
      <Button key="edit" type="button" variant="outline" className="h-11" onClick={onEdit}>
        Edit the draft
      </Button>,
    );
  }
  if (permissions.canPay && isOpenBill(bill.status))
    actions.push(
      <Button key="pay" type="button" className="h-11" onClick={onPay} data-autofocus>
        Pay this supplier
      </Button>,
    );
  if (permissions.canEnterBills && bill.status === "AWAITING_PAYMENT")
    actions.push(
      <Step key="cancel" label="Cancel bill" question="Cancel this bill?" body="A reversing entry takes it out of the books and the goods can be billed again. Only an unpaid bill can be cancelled." needsReason run={(reason) => cancelBill(bill.id, reason)} onDone={(b) => onChanged(b, `Bill ${b.billNumber} cancelled.`)} />,
    );
  return (
    <div className="space-y-5">
      {notice ? (
        <p role="status" className="rounded-md border border-emerald-700/40 bg-emerald-700/10 px-3 py-2 text-sm">
          {notice}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <BillStatusBadge status={bill.status} />
        <span className="text-sm text-muted-foreground">
          {bill.supplierName} · invoiced {formatDate(bill.billDate)} · due {formatDate(bill.dueDate)}
          {bill.poNumber !== null ? ` · PO ${bill.poNumber.toString().padStart(4, "0")}` : ""}
        </span>
      </div>
      {actions.length > 0 ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      <div className="overflow-x-auto" role="region" aria-label="Bill lines, scrollable" tabIndex={0}>
        <table className="w-full min-w-[40rem] text-sm">
          <caption className="sr-only">Bill lines</caption>
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th scope="col" className="py-1 pr-3 font-medium">Line</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">Qty</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">Net</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">VAT</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">GRNI cleared</th>
              <th scope="col" className="py-1 text-right font-medium">Price variance</th>
            </tr>
          </thead>
          <tbody>
            {bill.lines.map((l) => (
              <tr key={l.id} className="border-b last:border-b-0">
                <td className="py-1.5 pr-3">
                  {l.description}
                  <span className="block text-xs text-muted-foreground">{l.kind === "PO_MATCH" ? `Received goods · ${l.sku ?? ""}` : `Charged to ${l.expenseAccountCode ?? ""}`}</span>
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{displayQuantity(l.quantity)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{formatKES(l.lineNet)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{formatKES(l.lineVat)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{l.kind === "EXPENSE" ? "—" : l.grniCleared === null ? "on posting" : formatKES(l.grniCleared)}</td>
                <td className={cn("py-1.5 text-right tabular-nums", l.priceVariance !== null && l.priceVariance !== "0" && "font-semibold")}>
                  {l.kind === "EXPENSE" ? "—" : l.priceVariance === null ? "on posting" : l.priceVariance === "0" ? "none" : formatKES(l.priceVariance, { sign: "always" })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="rounded-md bg-muted p-3 text-sm">
        {[
          ["Net", bill.subtotalNet],
          ["VAT", bill.vatTotal],
          ["Total", bill.total],
          ...(posted ? [["Paid", bill.amountPaid] as const, ["Still owed", owedOn(bill)] as const] : []),
        ].map(([label, value]) => (
          <div key={label} className={cn("flex justify-between", (label === "Total" || label === "Still owed") && "font-semibold")}>
            <dt>{label}</dt>
            <dd className="tabular-nums">KES {formatKES(value)}</dd>
          </div>
        ))}
      </dl>
      {bill.lines.some((l) => l.priceVariance !== null && l.priceVariance !== "0") ? (
        <p className="text-sm text-muted-foreground">A price variance is the difference between what the supplier invoiced and what the order agreed; it is booked to purchase price variance, not added to the stock.</p>
      ) : null}
      {bill.notes ? <p className="text-sm">Notes: {bill.notes}</p> : null}
    </div>
  );
}

type Panel = { kind: "create" } | { kind: "bill"; id: string; notice: string | null } | { kind: "edit"; bill: Bill } | { kind: "pay"; bill: Bill };

function BillPanel({ id, initial, notice, permissions, setPanel }: { id: string; initial: Bill | undefined; notice: string | null; permissions: PayablesPermissions; setPanel: (p: Panel) => void }) {
  const bill = useBill(id, initial);
  if (bill.data === undefined) return bill.isError ? <ErrorState title="Couldn’t load the bill" description={bill.error.message} onRetry={() => void bill.refetch()} /> : <LoadingState label="Loading the bill" />;
  const current = bill.data;
  return (
    <BillDetail
      bill={current}
      permissions={permissions}
      notice={notice}
      onEdit={() => setPanel({ kind: "edit", bill: current })}
      onPay={() => setPanel({ kind: "pay", bill: current })}
      onChanged={(b, note) => setPanel({ kind: "bill", id: b.id, notice: note })}
    />
  );
}

export function BillsView({ permissions }: { permissions: PayablesPermissions }) {
  const ids = { status: useId() };
  const [status, setStatus] = useState<BillStatus | "">("");
  const bills = useBills(status);
  const [panel, setPanel] = useState<Panel | null>(null);
  const toBill = (b: Bill, notice: string | null = null) => setPanel({ kind: "bill", id: b.id, notice });

  let list: ReactNode;
  if (bills.isPending) list = <LoadingState label="Loading bills" lines={4} />;
  else if (bills.isError) list = <ErrorState title="Couldn’t load bills" description={bills.error.message} onRetry={() => void bills.refetch()} />;
  else if (bills.data.data.length === 0)
    list =
      status === "" ? (
        <EmptyState title="No supplier bills yet" description={permissions.canEnterBills ? "Enter a supplier's invoice when it arrives — against the purchase order its goods came on." : "Supplier invoices appear here."} />
      ) : (
        <EmptyState
          title={`No ${BILL_STATUS_LABEL[status].toLowerCase()} bills`}
          description="Try another status."
          action={
            <Button type="button" variant="outline" className="h-11" onClick={() => setStatus("")}>
              Show all bills
            </Button>
          }
        />
      );
  else
    list = (
      <ul aria-label="Supplier bills" className="space-y-2">
        {bills.data.data.map((b) => (
          <li key={b.id}>
            <button type="button" onClick={() => toBill(b)} className="flex min-h-11 w-full flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  {b.supplierName} · {b.billNumber} <BillStatusBadge status={b.status} />
                </span>
                <span className="block text-xs text-muted-foreground">
                  Invoiced {formatDate(b.billDate)} · due {formatDate(b.dueDate)}
                  {b.poNumber !== null ? ` · PO ${b.poNumber.toString().padStart(4, "0")}` : ""}
                </span>
              </span>
              <span className="text-right tabular-nums">
                <span className="block font-medium">KES {formatKES(b.total)}</span>
                {isOpenBill(b.status) ? <span className="block text-xs text-muted-foreground">owes KES {formatKES(owedOn(b))}</span> : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    );

  let sheet: ReactNode = null;
  if (panel?.kind === "create")
    sheet = (
      <Sheet key="create" title="Enter a supplier bill" onClose={() => setPanel(null)} wide>
        <BillForm bill={null} permissions={permissions} onSaved={(b) => toBill(b, `Bill ${b.billNumber} saved as a draft. Check it, then post it.`)} />
      </Sheet>
    );
  else if (panel?.kind === "bill") {
    const initial = bills.data?.data.find((b) => b.id === panel.id);
    sheet = (
      <Sheet key={`bill-${panel.id}-${panel.notice ?? ""}`} title={initial ? `Bill ${initial.billNumber}` : "Supplier bill"} onClose={() => setPanel(null)} wide>
        <BillPanel id={panel.id} initial={initial} notice={panel.notice} permissions={permissions} setPanel={setPanel} />
      </Sheet>
    );
  } else if (panel?.kind === "edit") {
    const bill = panel.bill;
    sheet = (
      <Sheet key="edit" title={`Edit bill ${bill.billNumber}`} onClose={() => toBill(bill)} wide>
        <Button type="button" variant="ghost" className="h-11 px-2" onClick={() => toBill(bill)}>
          <ArrowLeft aria-hidden /> Back to the bill
        </Button>
        <BillForm bill={bill} permissions={permissions} onSaved={(b) => toBill(b, "The draft was saved.")} />
      </Sheet>
    );
  } else if (panel?.kind === "pay") {
    const bill = panel.bill;
    sheet = (
      <Sheet key="pay" title={`Pay ${bill.supplierName}`} onClose={() => toBill(bill)} wide>
        <Button type="button" variant="ghost" className="h-11 px-2" onClick={() => toBill(bill)}>
          <ArrowLeft aria-hidden /> Back to the bill
        </Button>
        <PaymentForm supplier={{ id: bill.supplierId, name: bill.supplierName }} />
      </Sheet>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="w-full max-w-xs">
          <SelectField id={ids.status} label="Status" value={status} onChange={(v) => setStatus(v as BillStatus | "")}>
            <option value="">All bills</option>
            {BILL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {BILL_STATUS_LABEL[s]}
              </option>
            ))}
          </SelectField>
        </div>
        {permissions.canEnterBills ? (
          <Button type="button" className="h-11" onClick={() => setPanel({ kind: "create" })}>
            <Plus aria-hidden /> Enter a bill
          </Button>
        ) : null}
      </div>
      {list}
      {sheet}
    </div>
  );
}
