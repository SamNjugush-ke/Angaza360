"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Printer } from "lucide-react";
import { useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import type { Role } from "@/lib/auth/landing";
import { formatTime } from "@/lib/datetime";
import { formatKES } from "@/lib/money";
import { fetchShiftSales } from "@/lib/pos/api";
import { posKeys } from "@/lib/pos/hooks";
import { SaleDetail } from "./receipt-view";

// The sales rung on this shift, most recent first. Opening one shows its receipt — to reprint it,
// or, for a manager or owner, to void it.

export function ShiftSales({ shiftId, role, onClose }: { shiftId: string; role: Role; onClose: () => void }) {
  const [open, setOpen] = useState<{ id: string; saleNumber: string } | null>(null);
  const sales = useQuery({ queryKey: posKeys.shiftSales(shiftId), queryFn: () => fetchShiftSales(shiftId), staleTime: 0 });

  return (
    <Sheet title={open ? open.saleNumber : "Sales this shift"} onClose={onClose} wide>
      {open ? (
        <div className="space-y-4">
          <div className="no-print flex flex-wrap gap-2">
            <Button type="button" variant="outline" className="h-11" onClick={() => setOpen(null)} data-autofocus>
              <ArrowLeft aria-hidden /> Back to the list
            </Button>
            <Button type="button" variant="outline" className="h-11" onClick={() => window.print()}>
              <Printer aria-hidden /> Print receipt
            </Button>
          </div>
          <SaleDetail saleId={open.id} role={role} />
        </div>
      ) : sales.isPending ? (
        <LoadingState label="Loading this shift's sales" />
      ) : sales.isError ? (
        <ErrorState title="Couldn’t load this shift's sales" description={sales.error.message} onRetry={() => void sales.refetch()} />
      ) : sales.data.data.length === 0 ? (
        <EmptyState title="No sales yet" description="Sales rung on this shift appear here." />
      ) : (
        <ul aria-label="Sales" className="divide-y rounded-lg border">
          {sales.data.data.map((sale) => (
            <li key={sale.id}>
              <button
                type="button"
                onClick={() => setOpen({ id: sale.id, saleNumber: sale.saleNumber })}
                className="flex min-h-12 w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span>
                  <span className="font-medium">{sale.saleNumber}</span>
                  <span className="text-muted-foreground"> · {formatTime(sale.createdAt)}</span>
                  {sale.status === "VOIDED" ? <span className="ml-2 rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">Voided</span> : null}
                </span>
                <span className="tabular-nums">KES {formatKES(sale.total)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
