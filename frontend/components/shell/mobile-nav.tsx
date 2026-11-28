"use client";

import { LayoutGrid, Plus, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { bottomBarFor, type NavGroup } from "@/lib/nav/config";
import type { Role } from "@/lib/auth/landing";
import { cn } from "@/lib/utils";
import { NavList } from "./nav-list";

const FOCUSABLE = 'a[href], button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The structured "More" sheet: the full grouped nav in a modal dialog with a focus trap. */
function MoreSheet({
  groups,
  activePath,
  onClose,
  returnFocusTo,
}: {
  groups: readonly NavGroup[];
  activePath: string | null;
  onClose: () => void;
  returnFocusTo: HTMLElement | null;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = () => Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    focusables()[0]?.focus();

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      returnFocusTo?.focus();
    };
  }, [onClose, returnFocusTo]);

  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <div aria-hidden className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-2xl bg-background px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shadow-xl"
      >
        <div className="mb-2 flex items-center justify-between">
          <h2 id={titleId} className="font-display text-lg font-semibold">
            All sections
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-11 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-5" aria-hidden />
          </button>
        </div>
        <nav aria-label="All sections">
          <NavList groups={groups} activePath={activePath} tone="light" onNavigate={onClose} />
        </nav>
      </div>
    </div>
  );
}

const tabClass =
  "flex min-h-14 flex-1 flex-col items-center justify-center gap-1 rounded-md px-1 text-[0.6875rem] font-medium leading-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** The role-aware bottom bar: top destinations, a central New sale where the till applies, More. */
export function BottomBar({ role, groups, activePath }: { role: Role; groups: readonly NavGroup[]; activePath: string | null }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const [moreButton, setMoreButton] = useState<HTMLButtonElement | null>(null);
  const { destinations, newSale } = bottomBarFor(role);

  const tab = (item: (typeof destinations)[number]) => {
    const Icon = item.icon;
    const active = item.path === activePath;
    return (
      <li key={item.path} className="flex flex-1">
        <Link
          href={item.path}
          aria-current={active ? "page" : undefined}
          className={cn(tabClass, active ? "text-primary" : "text-muted-foreground hover:text-foreground")}
        >
          <Icon className="size-5" aria-hidden />
          <span className="line-clamp-1">{item.label}</span>
        </Link>
      </li>
    );
  };

  const before = newSale ? destinations.slice(0, 2) : destinations;
  const after = newSale ? destinations.slice(2) : [];

  return (
    <>
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      >
        <ul className="mx-auto flex max-w-lg items-stretch gap-1 px-2">
          {before.map(tab)}
          {newSale ? (
            <li className="flex flex-1 justify-center">
              <Link
                href="/pos"
                aria-current={activePath === "/pos" ? "page" : undefined}
                className="flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-md text-[0.6875rem] font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex size-11 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md">
                  <Plus className="size-6" aria-hidden />
                </span>
                New sale
              </Link>
            </li>
          ) : null}
          {after.map(tab)}
          <li className="flex flex-1">
            <button
              ref={setMoreButton}
              type="button"
              aria-haspopup="dialog"
              aria-expanded={open}
              onClick={() => setOpen(true)}
              className={cn(tabClass, "text-muted-foreground hover:text-foreground")}
            >
              <LayoutGrid className="size-5" aria-hidden />
              More
            </button>
          </li>
        </ul>
      </nav>
      {open ? <MoreSheet groups={groups} activePath={activePath} onClose={close} returnFocusTo={moreButton} /> : null}
    </>
  );
}
