"use client";

import { useState } from "react";
import { TabPanel, Tabs, type Tab } from "@/components/stock/kit";
import type { Role } from "@/lib/auth/landing";
import { procurementPermissions } from "@/lib/procurement/procurement";
import { OrdersView } from "./orders";
import { SuppliersView } from "./suppliers";

// PROCUREMENT: purchase orders from draft to closed, the goods receipts that bring the stock in,
// and — for the owner and manager, the roles the API lets keep them — the suppliers.

export function Procurement({ role }: { role: Role }) {
  const permissions = procurementPermissions(role);
  const tabs: Tab[] = [{ id: "orders", label: "Purchase orders" }, ...(permissions.canUseSuppliers ? [{ id: "suppliers", label: "Suppliers" }] : [])];
  const [active, setActive] = useState("orders");
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="font-display text-2xl font-semibold">Procurement</h1>
        <p className="text-sm text-muted-foreground">Order from suppliers, approve, and receive the goods into stock.</p>
      </div>
      <div>
        <Tabs tabs={tabs} active={active} onChange={setActive} label="Procurement" />
        <TabPanel id={active}>
          {active === "orders" ? <OrdersView permissions={permissions} /> : null}
          {active === "suppliers" && permissions.canUseSuppliers ? <SuppliersView /> : null}
        </TabPanel>
      </div>
    </div>
  );
}
