"use client";

import { useState } from "react";
import { TabPanel, Tabs, type Tab } from "@/components/stock/kit";
import type { Role } from "@/lib/auth/landing";
import { allocationPermissions } from "@/lib/allocations/allocations";
import { stockPermissions } from "@/lib/inventory/inventory";
import { LocationsView } from "./locations";
import { RequestsView } from "./requests";
import { StockView } from "./stock";
import { TillsView } from "./tills";
import { ValuationView } from "./valuation";
import { Greeting } from "@/components/shell/greeting";

// INVENTORY & LOCATIONS: the stock (levels, a product's split and history, and the moves the role
// may make), the locations that own it, and — for the owner, accountant and auditor only — what it
// is worth against the books. Since M4.5 W3 also the cashiers' stock requests (decided by an owner
// or manager) and which till each cashier sells from. Each tab and action mirrors the API's guards.

export function Inventory({ role }: { role: Role }) {
  const permissions = stockPermissions(role);
  const allocation = allocationPermissions(role);
  const tabs: Tab[] = [
    { id: "stock", label: "Stock" },
    { id: "locations", label: "Locations" },
    ...(allocation.canReadRequests ? [{ id: "requests", label: "Stock requests" }] : []),
    ...(allocation.canManageTills ? [{ id: "tills", label: "Cashier tills" }] : []),
    ...(permissions.canSeeValuation ? [{ id: "valuation", label: "Valuation" }] : []),
  ];
  const [active, setActive] = useState("stock");

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Greeting />
        <h1 className="font-display text-2xl font-semibold">Inventory & locations</h1>
        <p className="text-sm text-muted-foreground">
          {permissions.canMoveStock ? "What you hold and where — receive, adjust, transfer" + (permissions.canWriteOff ? " and write off" : "") + " stock." : "What the business holds and where."}
        </p>
      </div>
      <div>
        <Tabs tabs={tabs} active={active} onChange={setActive} label="Inventory" />
        <TabPanel id={active}>
          {active === "stock" ? <StockView permissions={permissions} /> : null}
          {active === "locations" ? <LocationsView canManage={permissions.canManageLocations} /> : null}
          {active === "valuation" && permissions.canSeeValuation ? <ValuationView /> : null}
          {active === "requests" && allocation.canReadRequests ? <RequestsView permissions={allocation} /> : null}
          {active === "tills" && allocation.canManageTills ? <TillsView /> : null}
        </TabPanel>
      </div>
    </div>
  );
}
