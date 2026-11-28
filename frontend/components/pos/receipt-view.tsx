"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Printer, Plus } from "lucide-react";
import { useEffect, useRef } from "react";
import { ErrorState, LoadingState } from "@/components/states/states";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/datetime";
import { formatKES } from "@/lib/money";
import type { Role } from "@/lib/auth/landing";
import { fetchReceipt, fetchSale } from "@/lib/pos/api";
import { posKeys } from "@/lib/pos/hooks";
import { displayQuantity } from "@/lib/pos/quantity";
import { TENDER_LABEL, type Receipt, type VoidResult } from "@/lib/pos/types";
import { VoidSale } from "./void-sale";

// The receipt, exactly as the server built it: the business header and branding, the lines, the
// VAT summary BY KRA TAX CODE (a seller who is not VAT-registered prints one D line, "No VAT — not
// VAT registered"), the tenders, what was handed over and the change, the customer's points — and
// the eTIMS block ONLY when the sale was SIGNED by KRA. A sale that was not filed prints nothing
// that could pass for a fiscal invoice. It prints on a thermal-width slip (the print stylesheet).

const HEX = /^#[0-9a-fA-F]{6}$/;

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={strong ? "flex justify-between font-semibold" : "flex justify-between"}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

export function ReceiptSlip({ receipt }: { receipt: Receipt }) {
  const { business } = receipt;
  const accent = business.brandPrimaryColor !== null && HEX.test(business.brandPrimaryColor) ? business.brandPrimaryColor : undefined;
  const signed = receipt.etims.fiscalStatus === "SIGNED";

  return (
    <article aria-label="Receipt" className="receipt-slip mx-auto w-full max-w-sm space-y-3 rounded-lg border bg-background p-4 font-mono text-xs leading-relaxed text-foreground">
      <header className="space-y-0.5 border-b-2 pb-2 text-center" style={accent ? { borderColor: accent } : undefined}>
        {business.logoUrl ? (
          // A tenant-set https URL; next/image would need every tenant's host allow-listed.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={business.logoUrl} alt={`${business.name} logo`} width={96} height={48} className="mx-auto h-12 w-auto object-contain" />
        ) : null}
        <p className="font-sans text-sm font-semibold">{business.legalName ?? business.name}</p>
        {business.addressLine ? <p>{business.addressLine}</p> : null}
        {business.phone ? <p>Tel {business.phone}</p> : null}
        {business.email ? <p>{business.email}</p> : null}
        {business.kraPin ? <p>KRA PIN {business.kraPin}</p> : null}
      </header>

      <div className="flex justify-between">
        <span>{receipt.saleNumber}</span>
        <span>{formatDateTime(receipt.timestamp)}</span>
      </div>
      {receipt.status === "VOIDED" ? <p className="text-center font-semibold">VOIDED</p> : null}

      <ul aria-label="Items" className="space-y-1 border-y py-2">
        {receipt.lines.map((line, index) => (
          <li key={`${line.description}-${index.toString()}`}>
            <p>{line.description}</p>
            <div className="flex justify-between">
              <span>
                {displayQuantity(line.quantity)} × {formatKES(line.unitPrice)}
                {line.discount !== "0" ? ` − ${formatKES(line.discount)}` : ""} [{line.taxCode}]
              </span>
              <span className="tabular-nums">{formatKES(line.lineTotal)}</span>
            </div>
          </li>
        ))}
      </ul>

      <div className="space-y-0.5">
        <Row label="Subtotal" value={formatKES(receipt.vatSummary.subtotal)} />
        <Row label="VAT" value={formatKES(receipt.vatSummary.vatTotal)} />
        <Row label="TOTAL KES" value={formatKES(receipt.vatSummary.total)} strong />
      </div>

      <table className="w-full border-y py-1">
        <caption className="sr-only">VAT by tax code</caption>
        <thead>
          <tr className="text-left">
            <th scope="col" className="font-normal">Code</th>
            <th scope="col" className="text-right font-normal">Amount</th>
            <th scope="col" className="text-right font-normal">VAT</th>
          </tr>
        </thead>
        <tbody>
          {receipt.taxCodeSummary.map((row) => (
            <tr key={row.code}>
              <td>
                {row.code} {row.label}
              </td>
              <td className="text-right tabular-nums">{formatKES(row.vatableAmount)}</td>
              <td className="text-right tabular-nums">{formatKES(row.vatAmount)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="space-y-0.5">
        {receipt.tenders.map((tender, index) => (
          <Row key={`${tender.tenderType}-${index.toString()}`} label={TENDER_LABEL[tender.tenderType]} value={formatKES(tender.amount)} />
        ))}
        <Row label="Tendered" value={formatKES(receipt.amountTendered)} />
        <Row label="Change" value={formatKES(receipt.changeDue)} strong />
      </div>

      {receipt.customer ? (
        <p className="border-t pt-2">
          Customer: {receipt.customer.name} · {receipt.customer.loyaltyPoints.toString()} points
        </p>
      ) : null}

      {signed ? (
        <section aria-label="KRA eTIMS" className="space-y-0.5 border-t pt-2">
          <p className="font-semibold">KRA eTIMS fiscal invoice</p>
          {receipt.etims.invoiceNumber ? <p>Invoice no. {receipt.etims.invoiceNumber}</p> : null}
          {receipt.etims.kraReceiptNumber ? <p>KRA receipt {receipt.etims.kraReceiptNumber}</p> : null}
          {receipt.etims.sdcDateTime ? <p>Signed {receipt.etims.sdcDateTime}</p> : null}
          {receipt.etims.rcptSign ? <p className="break-all">Signature {receipt.etims.rcptSign}</p> : null}
          {receipt.etims.qrCode ? <p className="break-all">Verify at {receipt.etims.qrCode}</p> : null}
        </section>
      ) : null}

      {receipt.footer ? <p className="border-t pt-2 text-center">{receipt.footer}</p> : null}
    </article>
  );
}

/**
 * One sale as the till shows it after the fact: the void action (or who may take it) and the
 * receipt, ready to print. Used straight after a sale and from the shift's sales list.
 */
export function SaleDetail({ saleId, role }: { saleId: string; role: Role }) {
  const client = useQueryClient();
  const receipt = useQuery({ queryKey: posKeys.receipt(saleId), queryFn: () => fetchReceipt(saleId) });
  const sale = useQuery({ queryKey: posKeys.sale(saleId), queryFn: () => fetchSale(saleId), retry: false });

  function voided(result: VoidResult) {
    client.setQueryData(posKeys.sale(saleId), result);
    void client.invalidateQueries({ queryKey: posKeys.receipt(saleId) });
    void client.invalidateQueries({ queryKey: ["pos", "shift"] });
    void client.invalidateQueries({ queryKey: ["pos", "shift-sales"] });
  }

  return (
    <div className="space-y-4">
      {sale.data ? (
        <div className="no-print">
          <VoidSale sale={sale.data} role={role} onVoided={voided} />
        </div>
      ) : null}
      {receipt.isPending ? (
        <LoadingState label="Loading the receipt" />
      ) : receipt.isError ? (
        <ErrorState title="The sale is saved, but the receipt couldn’t load" description={receipt.error.message} onRetry={() => void receipt.refetch()} />
      ) : (
        <div className="print-area">
          <ReceiptSlip receipt={receipt.data} />
        </div>
      )}
    </div>
  );
}

export function ReceiptView({ saleId, onNewSale, role }: { saleId: string; onNewSale: () => void; role: Role }) {
  const receipt = useQuery({ queryKey: posKeys.receipt(saleId), queryFn: () => fetchReceipt(saleId) });
  const newSale = useRef<HTMLButtonElement>(null);
  const ready = receipt.isSuccess;
  useEffect(() => {
    if (ready) newSale.current?.focus();
  }, [ready]);

  return (
    <div className="space-y-4">
      <div className="no-print flex flex-wrap items-center justify-between gap-2" role="status">
        <p className="font-display text-lg font-semibold">Sale complete</p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" className="h-12" onClick={() => window.print()} disabled={!ready}>
            <Printer aria-hidden /> Print receipt
          </Button>
          <Button ref={newSale} type="button" className="h-12" onClick={onNewSale}>
            <Plus aria-hidden /> New sale
          </Button>
        </div>
      </div>
      <SaleDetail saleId={saleId} role={role} />
    </div>
  );
}
