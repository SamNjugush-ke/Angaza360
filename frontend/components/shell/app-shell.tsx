"use client";

import { Plus } from "lucide-react";
import { ActingAsBanner } from "@/components/admin/act-as";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { DataProvider } from "@/components/providers/data-provider";
import { Button } from "@/components/ui/button";
import { PRODUCT_NAME } from "@/lib/brand";
import { activeNavPath, canReadLocations, canSell, navFor } from "@/lib/nav/config";
import { initials, ROLE_LABEL } from "@/lib/nav/roles";
import { AssignedTill } from "./assigned-till";
import { SignedInProvider } from "./greeting";
import { LocationProvider, LocationSelector } from "./location";
import { BottomBar } from "./mobile-nav";
import { NavList } from "./nav-list";
import type { ShellContext } from "./types";
import { UserMenu } from "./user-menu";

// The authenticated shell: one component for all three workspaces, each with its own nav set
// from lib/nav/config. Everything shown is filtered by the session's role; nothing here grants
// access — the backend decides every read and write.
//
// Desktop (lg+): the navy sidebar and a top bar. Mobile: a RECOMPOSED top bar (business, location
// chip, profile) and a role-aware bottom bar with a grouped "More" sheet.

// Honest: there is no global search yet, so no search control is shown until one exists (M4.5 W3).

export function AppShell({ context, children }: { context: ShellContext; children: ReactNode }) {
  const pathname = usePathname();
  const groups = navFor(context.role);
  const active = activeNavPath(pathname, groups.flatMap((group) => group.items));
  const mainGroups = groups.filter((group) => group.placement === "main");
  const footGroups = groups.filter((group) => group.placement === "foot");
  const sells = canSell(context.role);

  return (
    <DataProvider>
      <SignedInProvider context={context}>
      <LocationProvider enabled={canReadLocations(context.role)}>
        <div className="min-h-screen bg-background">
          <a
            href="#main"
            className="sr-only z-50 rounded-md bg-background px-4 py-2 focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:ring-2 focus:ring-ring"
          >
            Skip to content
          </a>

          <aside
            aria-label="Sidebar"
            className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col bg-angaza-navy text-angaza-white lg:flex"
          >
            <div className="px-5 pb-4 pt-6">
              <Image src="/brand/angaza360-logo-white.svg" alt={PRODUCT_NAME} width={160} height={36} unoptimized className="h-8 w-auto" />
            </div>
            <div className="mx-3 rounded-md bg-white/5 px-3 py-3">
              <p className="truncate font-display text-sm font-semibold">{context.contextName}</p>
              <p className="text-xs text-white/70">{ROLE_LABEL[context.role]}</p>
            </div>
            <nav aria-label="Main" className="flex flex-1 flex-col overflow-y-auto px-3 pb-4">
              <div className="space-y-1">
                <NavList groups={mainGroups} activePath={active} tone="dark" />
              </div>
              {footGroups.length > 0 ? (
                <div className="mt-auto border-t border-white/10 pt-3">
                  <NavList groups={footGroups} activePath={active} tone="dark" />
                </div>
              ) : null}
            </nav>
          </aside>

          <div className="lg:pl-64">
            {/* Desktop top bar */}
            <header
              aria-label="Toolbar"
              className="sticky top-0 z-20 hidden h-16 items-center gap-4 border-b bg-background/95 px-6 backdrop-blur lg:flex"
            >
              <div className="ml-auto flex items-center gap-3">
                {context.role === "CASHIER" ? <AssignedTill variant="bar" /> : <LocationSelector variant="bar" />}
                {sells ? (
                  <Button asChild className="h-11">
                    <Link href="/pos">
                      <Plus aria-hidden />
                      New sale
                    </Link>
                  </Button>
                ) : null}
                <UserMenu context={context} />
              </div>
            </header>

            {/* Mobile top bar: recomposed, not the desktop bar shrunk */}
            <header
              aria-label="Business bar"
              className="sticky top-0 z-20 flex items-center gap-3 border-b bg-background/95 px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] backdrop-blur lg:hidden"
            >
              <span
                aria-hidden
                className="flex size-10 shrink-0 items-center justify-center rounded-full bg-angaza-navy font-display text-sm font-semibold text-angaza-white"
              >
                {initials(context.contextName)}
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <p className="truncate font-display text-sm font-semibold">{context.contextName}</p>
                {context.role === "CASHIER" ? <AssignedTill variant="chip" /> : <LocationSelector variant="chip" />}
              </div>
              <UserMenu context={context} compact />
            </header>

            {context.actingAs ? <ActingAsBanner name={context.actingAs.name} /> : null}
            <main id="main" tabIndex={-1} className="px-4 pb-28 pt-6 focus:outline-none lg:px-8 lg:pb-8">
              {children}
            </main>
          </div>

          <BottomBar role={context.role} groups={groups} activePath={active} />
        </div>
      </LocationProvider>
      </SignedInProvider>
    </DataProvider>
  );
}
