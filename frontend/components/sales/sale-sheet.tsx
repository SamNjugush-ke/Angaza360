"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Printer, ReceiptText } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ReceiptSlip } from "@/components/pos/receipt-view";
import { VoidSale } from "@/components/pos/void-sale";
import { useWorkingLocation } from "@/components/shell/location";
import { ErrorState, LoadingState } from "@/components/states/states";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import type { Role } from "@/lib/auth/landing";
import { formatDateTime } from "@/lib/datetime";
import { formatKES } from "@/lib/money";
import { fetchCustomers, fetchReceipt, fetchSale } from "@/lib/pos/api";
import { posKeys } from "@/lib/pos/hooks";
import { displayQuantity } from "@/lib/pos/quantity";
import type { SaleRecord, VoidResult } from "@/lib/pos/types";
import { businessTimeOf, canReadCustomers, FISCAL_LABEL, PAYMENT_STATUS_LABEL, salesKeys, TENDER_STATUS_LABEL, tenderName, type SaleRow } from "@/lib/sales/sales";
import { SaleStatusBadge } from "./badges";

// One sale, opened from the list. The OPERATIONAL view first — every line with its tax code, every
// tender with its channel, status and M-Pesa reference, the totals, payment and fiscal status, the
// selling location and, once voided, the reason (shown by the void control) — distinct from the customer's receipt, which is
// one click away to view and reprint. A manager or owner can void from here.

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b py-1.5 last:border-b-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

function rate(vatRate: string): string {
  return `${vatRate.replace(/\.?0+$/, "") || "0"}%`;
}

function Lines({ sale }: { sale: SaleRecord }) {
  return (
    <section aria-labelledby="sale-lines" className="space-y-2">
      <h3 id="sale-lines" className="font-medium">
        Items
      </h3>
      <table className="hidden w-full text-sm md:table">
        <caption className="sr-only">Items sold</caption>
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th scope="col" className="py-1 pr-3 font-medium">SKU</th>
            <th scope="col" className="py-1 pr-3 font-medium">Item</th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">Qty</th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">Unit price</th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">Discount</th>
            <th scope="col" className="py-1 pr-3 font-medium">VAT</th>
            <th scope="col" className="py-1 text-right font-medium">Line total</th>
          </tr>
        </thead>
        <tbody>
          {sale.lines.map((line) => (
            <tr key={line.lineNumber} className="border-b last:border-b-0">
              <td className="py-1.5 pr-3 font-mono text-xs">{line.sku}</td>
              <td className="py-1.5 pr-3">{line.name}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{displayQuantity(line.quantity)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{formatKES(line.unitPrice)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{line.discount === "0" ? "—" : formatKES(line.discount)}</td>
              <td className="py-1.5 pr-3 whitespace-nowrap">
                {rate(line.vatRate)} · {line.taxCode}
              </td>
              <td className="py-1.5 text-right tabular-nums">{formatKES(line.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="space-y-2 md:hidden" aria-label="Items sold">
        {sale.lines.map((line) => (
          <li key={line.lineNumber} className="rounded-lg border p-3 text-sm">
            <p className="flex justify-between gap-3 font-medium">
              <span>{line.name}</span>
              <span className="tabular-nums">KES {formatKES(line.lineTotal)}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              <span className="font-mono">{line.sku}</span> · {displayQuantity(line.quantity)} × {formatKES(line.unitPrice)}
              {line.discount === "0" ? "" : ` − ${formatKES(line.discount)}`} · VAT {rate(line.vatRate)} · {line.taxCode}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Tenders({ sale }: { sale: SaleRecord }) {
  return (
    <section aria-labelledby="sale-tenders" className="space-y-2">
      <h3 id="sale-tenders" className="font-medium">
        Payments
      </h3>
      <ul className="divide-y rounded-lg border text-sm">
        {sale.tenders.map((tender) => (
          <li key={tender.id} className="space-y-0.5 px-3 py-2">
            <p className="flex justify-between gap-3">
              <span className="font-medium">{tenderName(tender)}</span>
              <span className="tabular-nums">KES {formatKES(tender.amount)}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {TENDER_STATUS_LABEL[tender.status]}
              {tender.mpesaReference ? ` · M-Pesa ref ${tender.mpesaReference}` : ""}
              {tender.cashReceived !== null ? ` · KES ${formatKES(tender.cashReceived)} handed over` : ""}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Detail({ sale, role, location, customer, onReceipt, onVoided }: { sale: SaleRecord; role: Role; location: string; customer: string; onReceipt: () => void; onVoided: (result: VoidResult) => void }) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <SaleStatusBadge status={sale.status} />
        <span className="text-sm text-muted-foreground">{formatDateTime(businessTimeOf(sale))}</span>
      </div>

      <dl className="text-sm">
        <Fact label="Customer">{customer}</Fact>
        <Fact label="Sold from">{location}</Fact>
        <Fact label="Payment">{PAYMENT_STATUS_LABEL[sale.paymentStatus]}</Fact>
        <Fact label="KRA eTIMS">{FISCAL_LABEL[sale.fiscalStatus]}</Fact>
        {sale.origin === "OFFLINE_SYNCED" ? <Fact label="Captured">Offline{sale.syncedAt ? `, synced ${formatDateTime(sale.syncedAt)}` : ""}</Fact> : null}
      </dl>

      <Lines sale={sale} />
      <Tenders sale={sale} />

      <dl className="rounded-md bg-muted p-3 text-sm">
        <div className="flex justify-between">
          <dt>Subtotal</dt>
          <dd className="tabular-nums">KES {formatKES(sale.subtotal)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>VAT</dt>
          <dd className="tabular-nums">KES {formatKES(sale.vatTotal)}</dd>
        </div>
        <div className="flex justify-between pt-1 text-base font-semibold">
          <dt>Total</dt>
          <dd className="tabular-nums">KES {formatKES(sale.total)}</dd>
        </div>
      </dl>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <Button type="button" variant="outline" className="h-11" onClick={onReceipt} data-autofocus>
          <ReceiptText aria-hidden /> View / print receipt
        </Button>
        <VoidSale
          sale={sale}
          role={role}
          onVoided={onVoided}
          refusalAction={
            <Link href="/pos" className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4">
              Open a shift on the till, then void again
            </Link>
          }
        />
      </div>
    </div>
  );
}

function ReceiptPane({ saleId, onBack }: { saleId: string; onBack: () => void }) {
  const receipt = useQuery({ queryKey: posKeys.receipt(saleId), queryFn: () => fetchReceipt(saleId) });
  return (
    <div className="space-y-4">
      <div className="no-print flex flex-wrap gap-2">
        <Button type="button" variant="outline" className="h-11" onClick={onBack} data-autofocus>
          <ArrowLeft aria-hidden /> Back to the sale
        </Button>
        <Button type="button" className="h-11" onClick={() => window.print()} disabled={!receipt.isSuccess}>
          <Printer aria-hidden /> Print receipt
        </Button>
      </div>
      {receipt.isPending ? (
        <LoadingState label="Loading the receipt" />
      ) : receipt.isError ? (
        <ErrorState title="Couldn’t load the receipt" description={receipt.error.message} onRetry={() => void receipt.refetch()} />
      ) : (
        <div className="print-area">
          <ReceiptSlip receipt={receipt.data} />
        </div>
      )}
    </div>
  );
}

export function SalesDetailSheet({ sale: row, role, onClose }: { sale: SaleRow; role: Role; onClose: () => void }) {
  const client = useQueryClient();
  const [mode, setMode] = useState<"detail" | "receipt">("detail");
  // The list row is the sale already; the detail is re-read so it is current (a void elsewhere).
  const sale = useQuery({ queryKey: salesKeys.detail(row.id), queryFn: () => fetchSale(row.id), placeholderData: row, staleTime: 0 });
  const customers = useQuery({ queryKey: ["pos", "customers"], queryFn: fetchCustomers, enabled: canReadCustomers(role) });
  const places = useWorkingLocation();
  // Switching between the details and the receipt moves focus to the new pane's first action
  // (the sheet itself focuses on opening), so it is never left on a button that just went away.
  const pane = useRef<HTMLDivElement>(null);
  const switched = useRef(false);
  useEffect(() => {
    if (!switched.current) {
      switched.current = true;
      return;
    }
    pane.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [mode]);

  function voided(result: VoidResult) {
    client.setQueryData(salesKeys.detail(row.id), result);
    void client.invalidateQueries({ queryKey: salesKeys.all });
    void client.invalidateQueries({ queryKey: posKeys.receipt(row.id) });
    void client.invalidateQueries({ queryKey: ["pos", "shift"] });
  }

  let body: ReactNode;
  if (mode === "receipt") {
    body = <ReceiptPane saleId={row.id} onBack={() => setMode("detail")} />;
  } else if (sale.isError && sale.data === undefined) {
    body = <ErrorState title="Couldn’t load this sale" description={sale.error.message} onRetry={() => void sale.refetch()} />;
  } else if (sale.data === undefined) {
    body = <LoadingState label="Loading the sale" />;
  } else {
    const current = sale.data;
    const customer =
      current.customerId === null ? "Walk-in" : (customers.data?.data.find((c) => c.id === current.customerId)?.name ?? "Account customer");
    const place = current.sellingLocationId === null ? null : places?.locations.find((l) => l.id === current.sellingLocationId);
    const location = current.sellingLocationId === null ? "Main store" : (place?.name ?? "A location you can’t view");
    body = <Detail sale={current} role={role} location={location} customer={customer} onReceipt={() => setMode("receipt")} onVoided={voided} />;
  }

  return (
    <Sheet title={row.saleNumber} onClose={onClose} wide>
      <div ref={pane}>{body}</div>
    </Sheet>
  );
}
