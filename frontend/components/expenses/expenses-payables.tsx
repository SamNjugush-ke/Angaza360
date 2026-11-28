"use client";

import { useState } from "react";
import { SuppliersView } from "@/components/procurement/suppliers";
import { TabPanel, Tabs, type Tab } from "@/components/stock/kit";
import type { Role } from "@/lib/auth/landing";
import { payablesPermissions } from "@/lib/payables/payables";
import { ApAgingView } from "./ap-aging";
import { BillsView } from "./bills";
import { ExpensesView } from "./expenses";
import { PaymentsView } from "./payments";

// EXPENSES & PAYABLES: costs paid as they happen, supplier invoices from draft to paid, the payments
// against them, what is owed by age — and, for the owner and manager, the suppliers themselves.
// Writing is the owner's, manager's and accountant's; the auditor reads (the API's guards).

export function ExpensesPayables({ role }: { role: Role }) {
  const permissions = payablesPermissions(role);
  const tabs: Tab[] = [
    { id: "expenses", label: "Expenses" },
    { id: "bills", label: "Supplier bills" },
    { id: "payments", label: "Payments" },
    { id: "aging", label: "Aging" },
    ...(permissions.canReadSuppliers ? [{ id: "suppliers", label: "Suppliers" }] : []),
  ];
  const [active, setActive] = useState("expenses");
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="font-display text-2xl font-semibold">Expenses & payables</h1>
        <p className="text-sm text-muted-foreground">What the business spends, what it owes its suppliers, and what it has paid them.</p>
      </div>
      <div>
        <Tabs tabs={tabs} active={active} onChange={setActive} label="Expenses and payables" />
        <TabPanel id={active}>
          {active === "expenses" ? <ExpensesView canRecord={permissions.canRecordExpense} /> : null}
          {active === "bills" ? <BillsView permissions={permissions} /> : null}
          {active === "payments" ? <PaymentsView canPay={permissions.canPay} /> : null}
          {active === "aging" ? <ApAgingView /> : null}
          {active === "suppliers" && permissions.canReadSuppliers ? <SuppliersView /> : null}
        </TabPanel>
      </div>
    </div>
  );
}
