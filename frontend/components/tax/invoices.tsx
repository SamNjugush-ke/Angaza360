"use client";

import { ExternalLink } from "lucide-react";
import { useId, useState } from "react";
import { TextField } from "@/components/auth/form-bits";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { Done, SelectField } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { formatDateTime } from "@/lib/datetime";
import {
  creditNote,
  isNotSetUp,
  retryInvoice,
  STATUS_LABEL,
  STATUS_MEANING,
  STATUS_ORDER,
  TYPE_LABEL,
  useInvalidateTax,
  useInvoice,
  useInvoices,
  useSaleInvoices,
  type Invoice,
  type InvoiceStatus,
  type TaxPermissions,
} from "@/lib/tax/tax";
import { NotSetUp, StatusBadge } from "./shared";

// The fiscal-invoice dashboard: every invoice KRA has signed or is still owed, by status, and one
// invoice's KRA artefacts. Resubmitting keeps the invoice's number (the no-double-file rule); a
// credit note is the only way to reverse a signed sale with KRA. Both are the owner's and the
// accountant's (the API's guards). Nothing here touches the books.

function Artefacts({ invoice }: { invoice: Invoice }) {
  const facts: Array<[string, string | null]> = [
    ["Invoice number", invoice.etimsInvoiceNumber.toString()],
    ["Type", TYPE_LABEL[invoice.invoiceType]],
    ["Sale", invoice.saleNumber],
    ["KRA receipt number", invoice.kraReceiptNumber],
    ["Receipt signature", invoice.rcptSign],
    ["Internal data", invoice.intrlData],
    ["Signed by KRA at", invoice.sdcDateTime],
    ["KRA result", invoice.resultCode || invoice.resultMsg ? [invoice.resultCode, invoice.resultMsg].filter(Boolean).join(" · ") : null],
    ["Submission attempts", invoice.retryCount.toString()],
    ["Last attempt", invoice.lastAttemptAt ? formatDateTime(invoice.lastAttemptAt) : null],
  ];
  return (
    <dl className="text-sm">
      {facts
        .filter(([, value]) => value !== null && value !== "")
        .map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4 border-b py-1.5 last:border-b-0">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-all text-right font-mono text-xs">{value}</dd>
          </div>
        ))}
      {invoice.qrCodeUrl ? (
        <div className="flex justify-between gap-4 py-1.5">
          <dt className="text-muted-foreground">KRA verification (QR)</dt>
          <dd className="text-right">
            <a href={invoice.qrCodeUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1 font-medium text-primary underline underline-offset-4">
              Open KRA’s check <ExternalLink className="size-3.5" aria-hidden />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

function Retry({ invoice, permissions, onDone }: { invoice: Invoice; permissions: TaxPermissions; onDone: (note: string) => void }) {
  const invalidate = useInvalidateTax();
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  async function retry() {
    setSaving(true);
    setError(null);
    try {
      const next = await retryInvoice(invoice.id);
      await invalidate();
      onDone(next.status === "SIGNED" ? `Invoice ${next.etimsInvoiceNumber.toString()} is now signed by KRA.` : `Resubmitted with the same number: ${STATUS_LABEL[next.status].toLowerCase()}.`);
    } catch (failure) {
      setError(failure);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="space-y-2">
      {error && isNotSetUp(error) ? <NotSetUp permissions={permissions} detail={(error as ApiHttpError).message} /> : null}
      {error && !isNotSetUp(error) ? (
        <p role="alert" className="text-sm text-destructive">
          {error instanceof ApiHttpError ? error.message : "It could not be resubmitted. Please try again."}
        </p>
      ) : null}
      <Button type="button" className="h-11" onClick={() => void retry()} disabled={saving}>
        {saving ? "Resubmitting…" : "Resubmit to KRA"}
      </Button>
    </div>
  );
}

function CreditNote({ invoice, onDone }: { invoice: Invoice; onDone: (note: string) => void }) {
  const ids = { title: useId(), reason: useId() };
  const invalidate = useInvalidateTax();
  const existing = useSaleInvoices(invoice.saleId);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const filed = (existing.data?.data ?? []).find((i) => i.invoiceType === "CREDIT_NOTE" && i.originalInvoiceId === invoice.id);
  if (filed) {
    return (
      <p className="text-sm">
        A credit note (invoice {filed.etimsInvoiceNumber.toString()}, {STATUS_LABEL[filed.status].toLowerCase()}) reverses this sale with KRA.
      </p>
    );
  }
  if (!asking) {
    return (
      <Button type="button" variant="outline" className="h-11" onClick={() => setAsking(true)}>
        File a credit note
      </Button>
    );
  }
  async function confirm() {
    if (reason.trim() === "") {
      setProblem("Give a reason — KRA records why the sale is reversed.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await creditNote(invoice.saleId, reason.trim());
      await invalidate();
      onDone(`Credit note ${result.invoice.etimsInvoiceNumber.toString()}: ${STATUS_LABEL[result.invoice.status].toLowerCase()}.`);
    } catch (failure) {
      setError(failure instanceof ApiHttpError ? failure.message : "The credit note could not be filed. Please try again.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div role="alertdialog" aria-labelledby={ids.title} className="space-y-2 rounded-md border p-3">
      <p id={ids.title} className="font-medium">
        File a credit note for {invoice.saleNumber}?
      </p>
      <p className="text-sm">It reverses the signed invoice with KRA. The sale stays signed; the reversal is its own fiscal record. It posts nothing to the books.</p>
      <TextField id={ids.reason} label="Reason for the credit note" autoComplete="off" value={reason} error={problem ?? undefined} onChange={(e) => setReason(e.target.value)} data-autofocus />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button type="button" variant="outline" className="h-11" onClick={() => setAsking(false)} disabled={saving}>
          Back
        </Button>
        <Button type="button" className="h-11" onClick={() => void confirm()} disabled={saving}>
          {saving ? "Filing…" : "Yes, file it"}
        </Button>
      </div>
    </div>
  );
}

export function InvoiceDetail({ id, permissions }: { id: string; permissions: TaxPermissions }) {
  const invoice = useInvoice(id);
  const [notice, setNotice] = useState<string | null>(null);
  if (invoice.isPending) return <LoadingState label="Loading the invoice" />;
  if (invoice.isError) return <ErrorState title="Couldn’t load the invoice" description={invoice.error.message} onRetry={() => void invoice.refetch()} />;
  const i = invoice.data;
  return (
    <div className="space-y-4">
      {notice ? <Done>{notice}</Done> : null}
      <div className="space-y-1">
        <StatusBadge status={i.status} />
        <p className="text-sm text-muted-foreground">{STATUS_MEANING[i.status]}</p>
      </div>
      <Artefacts invoice={i} />
      {permissions.canCorrect && i.status !== "SIGNED" ? <Retry invoice={i} permissions={permissions} onDone={setNotice} /> : null}
      {permissions.canCorrect && i.status === "SIGNED" && i.invoiceType === "SALE" ? <CreditNote invoice={i} onDone={setNotice} /> : null}
    </div>
  );
}

export function InvoicesView({ permissions }: { permissions: TaxPermissions }) {
  const ids = { status: useId(), type: useId() };
  const [status, setStatus] = useState<InvoiceStatus | "">("");
  const [invoiceType, setInvoiceType] = useState<Invoice["invoiceType"] | "">("");
  const invoices = useInvoices({ status, invoiceType });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <SelectField id={ids.status} label="Status" value={status} onChange={(v) => setStatus(v as InvoiceStatus | "")}>
          <option value="">Every status</option>
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </SelectField>
        <SelectField id={ids.type} label="Type" value={invoiceType} onChange={(v) => setInvoiceType(v as Invoice["invoiceType"] | "")}>
          <option value="">Sales and credit notes</option>
          <option value="SALE">{TYPE_LABEL.SALE}s</option>
          <option value="CREDIT_NOTE">{TYPE_LABEL.CREDIT_NOTE}s</option>
        </SelectField>
      </div>
      {status ? <p className="text-sm text-muted-foreground">{STATUS_MEANING[status]}</p> : null}
      {invoices.isPending ? <LoadingState label="Loading fiscal invoices" lines={5} /> : null}
      {invoices.isError ? <ErrorState title="Couldn’t load the fiscal invoices" description={invoices.error.message} onRetry={() => void invoices.refetch()} /> : null}
      {invoices.isSuccess && invoices.data.data.length === 0 ? (
        <EmptyState title={status || invoiceType ? "No invoices match" : "No KRA invoices yet"} description={status || invoiceType ? "Try another status or type." : "A sale gets a KRA invoice only when one is requested — at the till, or here under “File a sale”."} />
      ) : null}
      {invoices.isSuccess && invoices.data.data.length > 0 ? (
        <ul aria-label="Fiscal invoices" className="space-y-2">
          {invoices.data.data.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                onClick={() => setOpen(i.id)}
                aria-label={`Invoice ${i.etimsInvoiceNumber.toString()} · ${TYPE_LABEL[i.invoiceType]} · ${i.saleNumber} · ${STATUS_LABEL[i.status]}`}
                className="flex min-h-11 w-full flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span>
                  <span className="font-medium">Invoice {i.etimsInvoiceNumber.toString()}</span> <span className="text-muted-foreground">· {TYPE_LABEL[i.invoiceType]} · {i.saleNumber}</span>
                  <span className="block text-xs text-muted-foreground">
                    {formatDateTime(i.createdAt)}
                    {i.kraReceiptNumber ? ` · KRA receipt ${i.kraReceiptNumber}` : ""}
                    {i.status === "REJECTED" && i.resultMsg ? ` · ${i.resultMsg}` : ""}
                  </span>
                </span>
                <StatusBadge status={i.status} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {open ? (
        <Sheet key={open} title="KRA fiscal invoice" onClose={() => setOpen(null)} wide>
          <InvoiceDetail id={open} permissions={permissions} />
        </Sheet>
      ) : null}
    </div>
  );
}
