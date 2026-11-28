"use client";

import Link from "next/link";
import type { NavGroup } from "@/lib/nav/config";
import { cn } from "@/lib/utils";

interface NavListProps {
  groups: readonly NavGroup[];
  activePath: string | null;
  /** "dark" on the navy sidebar; "light" in the mobile More sheet. */
  tone: "dark" | "light";
  onNavigate?: () => void;
}

/** The grouped nav as lists of links; the active item carries aria-current and the gold marker. */
export function NavList({ groups, activePath, tone, onNavigate }: NavListProps) {
  return (
    <>
      {groups.map((group) => {
        const headingId = `nav-group-${tone}-${group.id}`;
        return (
          <div key={group.id} className="space-y-1">
            {group.label ? (
              <h2
                id={headingId}
                className={cn(
                  "px-3 pt-4 text-xs font-semibold uppercase tracking-wider",
                  tone === "dark" ? "text-white/70" : "text-muted-foreground",
                )}
              >
                {group.label}
              </h2>
            ) : null}
            <ul aria-labelledby={group.label ? headingId : undefined} className="space-y-1">
              {group.items.map((item) => {
                const active = item.path === activePath;
                const Icon = item.icon;
                return (
                  <li key={item.path}>
                    <Link
                      href={item.path}
                      aria-current={active ? "page" : undefined}
                      onClick={onNavigate}
                      className={cn(
                        "relative flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2",
                        tone === "dark"
                          ? "text-white/85 hover:bg-white/10 hover:text-white focus-visible:ring-angaza-gold"
                          : "text-foreground hover:bg-muted focus-visible:ring-ring",
                        active &&
                          (tone === "dark"
                            ? "bg-white/10 text-white before:absolute before:inset-y-2 before:left-0 before:w-1 before:rounded-full before:bg-angaza-gold"
                            : "bg-muted before:absolute before:inset-y-2 before:left-0 before:w-1 before:rounded-full before:bg-angaza-gold"),
                      )}
                    >
                      <Icon className="size-5 shrink-0" aria-hidden />
                      <span>{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </>
  );
}
