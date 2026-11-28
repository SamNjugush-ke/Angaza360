"use client";

import { useState } from "react";
import { TabPanel, Tabs, type Tab } from "@/components/stock/kit";
import type { Role } from "@/lib/auth/landing";
import { payrollPermissions } from "@/lib/payroll/payroll";
import { EmployeesView } from "./employees";
import { RemittancesView, runExtras } from "./money";
import { RunsView } from "./runs";
import { Greeting } from "@/components/shell/greeting";

// PAYROLL: the employee master and the monthly runs. HR (owner, manager, HR officer) keeps the
// employees and computes runs; the owner or a manager approves and posts them; the accountant and
// auditor read everything, payslips included (a recorded product decision).

export function Payroll({ role }: { role: Role }) {
  const permissions = payrollPermissions(role);
  const tabs: Tab[] = [
    { id: "runs", label: "Payroll runs" },
    { id: "employees", label: "Employees" },
    { id: "remittances", label: "Remittances" },
  ];
  const [active, setActive] = useState("runs");
  return (
    <div className="space-y-6">
      <div className="no-print space-y-1">
        <Greeting />
        <h1 className="font-display text-2xl font-semibold">Payroll</h1>
        <p className="text-sm text-muted-foreground">Monthly pay, worked out against the statutory rates in force: PAYE, NSSF, SHIF and the housing levy.</p>
      </div>
      <div>
        <div className="no-print">
          <Tabs tabs={tabs} active={active} onChange={setActive} label="Payroll" />
        </div>
        <TabPanel id={active}>
          {active === "runs" ? <RunsView permissions={permissions} extras={runExtras(permissions)} /> : null}
          {active === "employees" ? <EmployeesView permissions={permissions} /> : null}
          {active === "remittances" ? <RemittancesView /> : null}
        </TabPanel>
      </div>
    </div>
  );
}
