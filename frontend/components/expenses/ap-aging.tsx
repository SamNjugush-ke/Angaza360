"use client";

import { useId, useState } from "react";
import { TextField } from "@/components/auth/form-bits";
import { AgingTable, StatementTable } from "@/components/money/shared";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { Sheet } from "@/components/ui/sheet";
import { businessToday } from "@/lib/datetime";
import { formatKES } from "@/lib/money";
import { BILL_STATUS_LABEL, useApAging, useSupplierStatement } from "@/lib/payables/payables";

// What the business owes its suppliers, aged by each bill's DUE date (current means not yet due),
// and each supplier's statement: bills and payments with the running balance — the server's figures.

function SupplierStatementSheet({ supplier, onClose }: { supplier: { id: string; name: string }; onClose: () => void }) {
  const statement = useSupplierStatement(supplier.id);
  return (
    <Sheet title={`Statement — ${supplier.name}`} onClose={onClose} wide>
      {statement.isPending ? (
        <LoadingState label="Loading the statement" />
      ) : statement.isError ? (
        <ErrorState title="Couldn’t load the statement" description={statement.error.message} onRetry={() => void statement.refetch()} />
      ) : (
        <div className="space-y-4">
          <div className="rounded-lg border p-3">
            <p className="text-sm text-muted-foreground">Owed to {supplier.name}</p>
            <p className="font-display text-2xl font-semibold tabular-nums">KES {formatKES(statement.data.closingBalance)}</p>
          </div>
          <StatementTable
            caption={`Statement for ${supplier.name}`}
            chargedLabel="Billed"
            creditedLabel="Paid"
            lines={statement.data.entries.map((e, i) => ({
              key: `${e.reference}-${i.toString()}`,
              date: e.date,
              reference: e.reference,
              description: e.description,
              charged: e.charged,
              credited: e.paid,
              runningBalance: e.runningBalance,
              ...(e.billStatus ? { note: BILL_STATUS_LABEL[e.billStatus] } : {}),
            }))}
          />
        </div>
      )}
    </Sheet>
  );
}

export function ApAgingView() {
  const ids = { asOf: useId() };
  const [today] = useState(() => businessToday());
  const [asOf, setAsOf] = useState(today);
  const aging = useApAging(asOf, /^\d{4}-\d{2}-\d{2}$/.test(asOf));
  const [open, setOpen] = useState<{ id: string; name: string } | null>(null);
  return (
    <div className="space-y-4">
      <div className="max-w-xs">
        <TextField id={ids.asOf} label="As at" type="date" max={today} value={asOf} onChange={(e) => setAsOf(e.target.value)} hint="Aged from each bill's due date." />
      </div>
      {aging.isPending ? (
        <LoadingState label="Loading the aging" lines={4} />
      ) : aging.isError ? (
        <ErrorState title="Couldn’t load the aging" description={aging.error.message} onRetry={() => void aging.refetch()} />
      ) : aging.data.suppliers.length === 0 ? (
        <EmptyState title="Nothing owed to suppliers" description="No posted bill is unpaid as at this date." />
      ) : (
        <AgingTable
          caption="Payables by age"
          currentLabel="Not yet due"
          countLabel="open bills"
          rows={aging.data.suppliers.map((s) => ({ ...s, id: s.supplierId, name: s.supplierName, count: s.billCount }))}
          totals={aging.data.totals}
          grandTotal={aging.data.grandTotal}
          onOpen={(row) => setOpen({ id: row.id, name: row.name })}
        />
      )}
      {open ? <SupplierStatementSheet supplier={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
