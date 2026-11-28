"use client";

import Link from "next/link";
import type { Role } from "@/lib/auth/landing";
import { actionFor } from "@/lib/dashboard/attention";
import { isNotPermitted, type Gated } from "@/lib/dashboard/fetch";
import type { CustomerList, RecentSales } from "@/lib/dashboard/types";
import { BUSINESS_TZ } from "@/lib/datetime";
import { formatKES } from "@/lib/money";

type Sale = RecentSales["data"][number];

const timeFormatter = new Intl.DateTimeFormat("en-KE", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: BUSINESS_TZ,
});

/** When the sale HAPPENED: its business time when it was captured offline, else when it was rung. */
export function saleTime(sale: Pick<Sale, "businessTimestamp" | "createdAt">): string {
  return timeFormatter.format(new Date(sale.businessTimestamp ?? sale.createdAt));
}

const TENDER: Readonly<Record<Sale["tenders"][number]["tenderType"], string>> = {
  CASH: "Cash",
  MPESA: "M-Pesa",
  BANK_TRANSFER: "Bank transfer",
  CREDIT: "On account",
};

export function paidBy(sale: Pick<Sale, "tenders">): string {
  const kinds = [...new Set(sale.tenders.map((tender) => TENDER[tender.tenderType]))];
  return kinds.length === 1 ? (kinds[0] ?? "") : "Split payment";
}

const FISCAL: Readonly<Record<Sale["fiscalStatus"], string>> = {
  NOT_REQUESTED: "Not requested",
  PENDING_ETIMS: "Pending",
  SIGNED: "Signed",
  FAILED: "Failed",
};

/** The customer as this role may see them: a name, "Walk-in", or "Account customer" without access to names. */
export function customerLabel(sale: Pick<Sale, "customerId">, customers: Gated<CustomerList> | undefined): string {
  if (sale.customerId === null) return "Walk-in";
  if (customers === undefined || isNotPermitted(customers)) return "Account customer";
  return customers.data.find((customer) => customer.id === sale.customerId)?.name ?? "Account customer";
}

interface RecentSalesBodyProps {
  role: Role;
  sales: RecentSales;
  customers: Gated<CustomerList> | undefined;
  /** Show the eTIMS column — only for a business that has set up eTIMS. */
  showFiscal: boolean;
}

export function RecentSalesBody({ role, sales, customers, showFiscal }: RecentSalesBodyProps) {
  if (sales.data.length === 0) {
    const record = actionFor(role, "Record a sale", "/pos");
    return record ? (
      <p className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        No sales yet.
        <Link href={record.href} className="inline-flex min-h-11 items-center rounded-md font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Record your first sale
        </Link>
      </p>
    ) : (
      <p className="text-sm text-muted-foreground">No sales yet.</p>
    );
  }
  return (
    <>
      {/* Phones: one card per sale, nothing hidden off to the side. */}
      <ul className="divide-y sm:hidden" aria-label="Latest sales">
        {sales.data.map((sale) => {
          const voided = sale.status === "VOIDED";
          return (
            <li key={sale.id} className="flex items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{customerLabel(sale, customers)}</p>
                <p className="tabular text-sm text-muted-foreground">
                  {saleTime(sale)} · {paidBy(sale)}
                  {showFiscal ? ` · eTIMS ${FISCAL[sale.fiscalStatus].toLowerCase()}` : ""}
                </p>
              </div>
              <p className="tabular shrink-0 whitespace-nowrap text-right">
                {voided ? (
                  <>
                    <span className="mr-2 rounded border border-destructive/40 px-1.5 text-xs font-medium text-destructive">Voided</span>
                    <s className="text-muted-foreground">{formatKES(sale.total)}</s>
                  </>
                ) : (
                  formatKES(sale.total)
                )}
              </p>
            </li>
          );
        })}
      </ul>
      <div className="hidden sm:block">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Latest sales</caption>
          <thead>
            <tr className="border-b text-muted-foreground">
              <th scope="col" className="py-2 pr-4 font-medium">
                Time
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Customer
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Paid by
              </th>
              {showFiscal ? (
                <th scope="col" className="py-2 pr-4 font-medium">
                  eTIMS
                </th>
              ) : null}
              <th scope="col" className="py-2 text-right font-medium">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {sales.data.map((sale) => {
              const voided = sale.status === "VOIDED";
              return (
                <tr key={sale.id} className="border-b last:border-0">
                  <td className="tabular whitespace-nowrap py-2.5 pr-4">{saleTime(sale)}</td>
                  <td className="py-2.5 pr-4">{customerLabel(sale, customers)}</td>
                  <td className="py-2.5 pr-4">{paidBy(sale)}</td>
                  {showFiscal ? <td className="py-2.5 pr-4">{FISCAL[sale.fiscalStatus]}</td> : null}
                  <td className="tabular whitespace-nowrap py-2.5 text-right">
                    {voided ? (
                      <>
                        <span className="mr-2 rounded border border-destructive/40 px-1.5 text-xs font-medium text-destructive">Voided</span>
                        <s className="text-muted-foreground">{formatKES(sale.total)}</s>
                      </>
                    ) : (
                      formatKES(sale.total)
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
