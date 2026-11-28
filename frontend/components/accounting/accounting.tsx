"use client";

import { useState } from "react";
import { TabPanel, Tabs, type Tab } from "@/components/stock/kit";
import type { Role } from "@/lib/auth/landing";
import { accountingPermissions } from "@/lib/accounting/accounting";
import { AccountsView } from "./accounts";
import { JournalView } from "./journal";
import { PeriodsView } from "./periods";
import { ReportsView } from "./reports";

// ACCOUNTING & REPORTS: the financial statements, the journal, the chart of accounts and each
// account's ledger, and the accounting periods. Everyone allowed here reads everything; posting,
// reversing and closing are the owner's and accountant's, reopening the owner's (the API's guards).

export function Accounting({ role }: { role: Role }) {
  const permissions = accountingPermissions(role);
  const tabs: Tab[] = [
    { id: "reports", label: "Reports" },
    { id: "journal", label: "Journal" },
    { id: "accounts", label: "Chart of accounts" },
    { id: "periods", label: "Periods" },
  ];
  const [active, setActive] = useState("reports");
  return (
    <div className="space-y-6">
      <div className="no-print space-y-1">
        <h1 className="font-display text-2xl font-semibold">Accounting & reports</h1>
        <p className="text-sm text-muted-foreground">The books: statements to file and print, every posting, and the months they fall in.</p>
      </div>
      <div>
        <div className="no-print">
          <Tabs tabs={tabs} active={active} onChange={setActive} label="Accounting" />
        </div>
        <TabPanel id={active}>
          {active === "reports" ? <ReportsView /> : null}
          {active === "journal" ? <JournalView permissions={permissions} /> : null}
          {active === "accounts" ? <AccountsView /> : null}
          {active === "periods" ? <PeriodsView permissions={permissions} /> : null}
        </TabPanel>
      </div>
    </div>
  );
}
