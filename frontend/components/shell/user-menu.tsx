"use client";

import { ChevronDown, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { initials, ROLE_LABEL } from "@/lib/nav/roles";
import type { ShellContext } from "./types";

/** The user's name and email, and Sign out. A disclosure: Esc or a click outside closes it. */
export function UserMenu({ context, compact = false }: { context: ShellContext; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    function onPointer(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Account: ${context.fullName}`}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-11 min-w-11 items-center gap-2 rounded-md px-1.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* A decorative avatar. The initials are PAINTED (a pseudo-element), not text, so the
            button's visible label is exactly its accessible name (WCAG 2.5.3, label in name). */}
        <span
          aria-hidden
          data-initials={initials(context.fullName)}
          className="flex size-9 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground before:content-[attr(data-initials)]"
        />
        {compact ? null : (
          <>
            <span className="hidden text-sm font-medium xl:inline">{context.fullName}</span>
            <ChevronDown className="hidden size-4 xl:inline" aria-hidden />
          </>
        )}
      </button>
      {open ? (
        <div
          id={panelId}
          className="absolute right-0 top-full z-50 mt-2 w-72 space-y-3 rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg"
        >
          <div>
            <p className="font-medium">{context.fullName}</p>
            <p className="break-all text-sm text-muted-foreground">{context.email}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {ROLE_LABEL[context.role]} · {context.contextName}
            </p>
          </div>
          <Link
            href="/account/security"
            onClick={() => setOpen(false)}
            className="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ShieldCheck className="size-4" aria-hidden />
            Sign-in security
          </Link>
          <SignOutButton />
        </div>
      ) : null}
    </div>
  );
}
