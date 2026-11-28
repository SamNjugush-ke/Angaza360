"use client";

import { Search } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet } from "@/components/ui/sheet";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { formatDateTime } from "@/lib/datetime";
import { formatKES } from "@/lib/money";
import { businessTimeOf, FISCAL_LABEL } from "@/lib/sales/sales";
import { isNotSetUp, signSale, STATUS_LABEL, STATUS_MEANING, useInvalidateTax, useSaleSearch, type SignResult, type TaxPermissions } from "@/lib/tax/tax";
import { InvoiceDetail } from "./invoices";
import { NotSetUp } from "./shared";

// Filing a sale with KRA after the fact — a customer who asks for a KRA invoice once they have
// left. The sale is already final: signing changes only its fiscal status and posts nothing. A
// sale KRA has not signed may be filed (again); the server keeps the number it already holds, so a
// retry can never file the same sale twice.

function Outcome({ result, onView }: { result: SignResult; onView: (id: string) => void }) {
  const { invoice } = result;
  const words = result.alreadySigned
    ? `Already signed by KRA — invoice ${invoice.etimsInvoiceNumber.toString()}.`
    : invoice.status === "SIGNED"
      ? `Signed by KRA — invoice ${invoice.etimsInvoiceNumber.toString()}, KRA receipt ${invoice.kraReceiptNumber ?? ""}.`
      : invoice.status === "REJECTED"
        ? `KRA refused invoice ${invoice.etimsInvoiceNumber.toString()}${invoice.resultMsg ? `: ${invoice.resultMsg}` : ""}. Fix the cause, then resubmit it from Fiscal invoices.`
        : `Invoice ${invoice.etimsInvoiceNumber.toString()}: ${STATUS_LABEL[invoice.status].toLowerCase()}. ${STATUS_MEANING[invoice.status]}`;
  return (
    <div role="status" className="space-y-2 rounded-md border p-3 text-sm">
      <p>{words}</p>
      <Button type="button" variant="outline" className="h-11" onClick={() => onView(invoice.id)}>
        View the invoice
      </Button>
    </div>
  );
}

export function FileSaleView({ permissions }: { permissions: TaxPermissions }) {
  const ids = { search: useId() };
  const invalidate = useInvalidateTax();
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);
  const sales = useSaleSearch(q);
  const [signing, setSigning] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, SignResult>>({});
  const [errors, setErrors] = useState<Record<string, unknown>>({});
  const [open, setOpen] = useState<string | null>(null);

  async function sign(saleId: string) {
    setSigning(saleId);
    setErrors((e) => ({ ...e, [saleId]: null }));
    try {
      const result = await signSale(saleId);
      setResults((r) => ({ ...r, [saleId]: result }));
      await invalidate();
    } catch (failure) {
      setErrors((e) => ({ ...e, [saleId]: failure }));
    } finally {
      setSigning(null);
    }
  }
  const notSetUp = Object.values(errors).find((e) => isNotSetUp(e));

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Find a completed sale by its number to give the customer a KRA invoice. It changes nothing in the books: the sale and its VAT are already posted.</p>
      <div className="max-w-sm space-y-2">
        <Label htmlFor={ids.search}>Sale number</Label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input id={ids.search} type="search" className="h-11 pl-9" placeholder="e.g. SALE-20261105-000004" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </div>
      </div>
      {notSetUp ? <NotSetUp permissions={permissions} detail={(notSetUp as ApiHttpError).message} /> : null}
      {q === "" ? null : sales.isPending ? (
        <LoadingState label="Finding sales" lines={3} />
      ) : sales.isError ? (
        <ErrorState title="Couldn’t search the sales" description={sales.error.message} onRetry={() => void sales.refetch()} />
      ) : sales.data.data.length === 0 ? (
        <EmptyState title="No completed sale matches" description={`Nothing matches “${q}”. A voided sale cannot be filed — it did not happen.`} />
      ) : (
        <ul aria-label="Sales found" className="space-y-2">
          {sales.data.data.map((s) => {
            const result = results[s.id];
            const failure = errors[s.id];
            const signed = s.fiscalStatus === "SIGNED" || result?.invoice.status === "SIGNED";
            return (
              <li key={s.id} aria-label={s.saleNumber} className="space-y-2 rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span>
                    <span className="font-medium">{s.saleNumber}</span> <span className="tabular-nums">KES {formatKES(s.total)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {formatDateTime(businessTimeOf(s))} · {FISCAL_LABEL[result ? result.fiscalStatus : s.fiscalStatus]}
                    </span>
                  </span>
                  {permissions.canSign && !signed ? (
                    <Button type="button" className="h-11" onClick={() => void sign(s.id)} disabled={signing !== null} aria-label={`File ${s.saleNumber} with KRA`}>
                      {signing === s.id ? "Filing…" : "File with KRA"}
                    </Button>
                  ) : null}
                </div>
                {result ? <Outcome result={result} onView={setOpen} /> : null}
                {failure && !isNotSetUp(failure) ? (
                  <p role="alert" className="text-destructive">
                    {failure instanceof ApiHttpError ? failure.message : "It could not be filed. Please try again."}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {open ? (
        <Sheet key={open} title="KRA fiscal invoice" onClose={() => setOpen(null)} wide>
          <InvoiceDetail id={open} permissions={permissions} />
        </Sheet>
      ) : null}
    </div>
  );
}
