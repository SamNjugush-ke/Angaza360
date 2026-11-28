"use client";

import { useState } from "react";
import { TabPanel, Tabs, type Tab } from "@/components/stock/kit";
import type { Role } from "@/lib/auth/landing";
import { taxPermissions } from "@/lib/tax/tax";
import { DeviceView } from "./device";
import { FileSaleView } from "./file-sale";
import { InvoicesView } from "./invoices";
import { VatReturnView } from "./vat-return";

// eTIMS & TAX: the fiscal invoices KRA holds or is still owed, filing a sale after the fact,
// the business's eTIMS device, and the VAT return or Turnover Tax position (chosen by the regime).
// Tabs follow the API's guards: filing is not the auditor's; the device is the owner's and the
// accountant's to see.

export function Tax({ role }: { role: Role }) {
  const permissions = taxPermissions(role);
  const tabs: Tab[] = [
    { id: "invoices", label: "Fiscal invoices" },
    ...(permissions.canSign ? [{ id: "file", label: "File a sale" }] : []),
    { id: "return", label: "VAT / TOT return" },
    ...(permissions.canReadDevice ? [{ id: "device", label: "Device" }] : []),
  ];
  const [active, setActive] = useState("invoices");
  return (
    <div className="space-y-6">
      <div className="no-print space-y-1">
        <h1 className="font-display text-2xl font-semibold">KRA eTIMS & tax</h1>
        <p className="text-sm text-muted-foreground">KRA invoices for the sales that need one, and the tax the books say is due. None of it changes the books.</p>
      </div>
      <div>
        <div className="no-print">
          <Tabs tabs={tabs} active={active} onChange={setActive} label="KRA eTIMS & tax" />
        </div>
        <TabPanel id={active}>
          {active === "invoices" ? <InvoicesView permissions={permissions} /> : null}
          {active === "file" ? <FileSaleView permissions={permissions} /> : null}
          {active === "return" ? <VatReturnView /> : null}
          {active === "device" ? <DeviceView permissions={permissions} /> : null}
        </TabPanel>
      </div>
    </div>
  );
}
