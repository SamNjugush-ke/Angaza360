"use client";

import { useState } from "react";
import { TabPanel, Tabs, type Tab } from "@/components/stock/kit";
import type { Role } from "@/lib/auth/landing";
import { settingsPermissions } from "@/lib/settings/settings";
import { BrandingView } from "./branding";
import { IntegrationsView } from "./integrations";
import { ProfileView } from "./profile";
import { StatutoryView } from "./statutory";

// BUSINESS SETUP: the profile and tax regime, branding, the statutory schedules, and the owner's
// integration credentials. Tabs follow the API's guards: the manager reads the profile, branding
// and statutory schedules and changes none of them; the integrations are the owner's alone and are
// not shown to anyone else at all.

export const SETTINGS_TABS = ["profile", "branding", "statutory", "integrations"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export function Settings({ role, businessName, initialTab }: { role: Role; businessName: string; initialTab?: string }) {
  const permissions = settingsPermissions(role);
  const tabs: Tab[] = [
    { id: "profile", label: "Business profile" },
    { id: "branding", label: "Branding" },
    ...(permissions.canReadStatutory ? [{ id: "statutory", label: "Statutory" }] : []),
    ...(permissions.isOwner ? [{ id: "integrations", label: "Integrations" }] : []),
  ];
  const [active, setActive] = useState(tabs.some((t) => t.id === initialTab) ? (initialTab ?? "profile") : "profile");
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="font-display text-2xl font-semibold">Business setup</h1>
        <p className="text-sm text-muted-foreground">How the business is registered for tax, what its receipts print, the statutory rates it applies{permissions.isOwner ? ", and its payment and KRA connections" : ""}.</p>
      </div>
      <div>
        <Tabs tabs={tabs} active={active} onChange={setActive} label="Business setup" />
        <TabPanel id={active}>
          {active === "profile" ? <ProfileView owner={permissions.isOwner} /> : null}
          {active === "branding" ? <BrandingView owner={permissions.isOwner} businessName={businessName} /> : null}
          {active === "statutory" && permissions.canReadStatutory ? <StatutoryView owner={permissions.isOwner} /> : null}
          {active === "integrations" && permissions.isOwner ? <IntegrationsView /> : null}
        </TabPanel>
      </div>
    </div>
  );
}
