"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ErrorState, LoadingState } from "@/components/states/states";
import { ApiHttpError, isNotPermitted, type Gated } from "@/lib/dashboard/fetch";
import { cn } from "@/lib/utils";

// One dashboard panel: a titled card that owns its own loading, error and hidden states, so a
// failing source never takes the page with it. A source the role may not read hides the panel.

export interface PanelQuery<T> {
  data: Gated<T> | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
}

/** A specific, plain-language reason a panel could not load. */
export function loadFailureMessage(error: unknown, what: string): string {
  if (error instanceof ApiHttpError) {
    if (error.status === 0) return `We couldn't reach the server to load ${what}. Check your connection and try again.`;
    if (error.status === 429) return `Too many requests just now — wait a moment, then load ${what} again.`;
  }
  return `We couldn't load ${what} right now.`;
}

export function PanelLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex min-h-11 items-center rounded-md px-2 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </Link>
  );
}

interface PanelProps<T> {
  title: string;
  /** What the panel shows, for loading and error messages ("your sales trend"). */
  what: string;
  query: PanelQuery<T>;
  /** A link in the panel's header (a drill-through). */
  link?: { href: string; label: string };
  className?: string;
  /** Lines of skeleton while loading. */
  skeletonLines?: number;
  children: (data: T) => ReactNode;
}

export function Panel<T>({ title, what, query, link, className, skeletonLines = 3, children }: PanelProps<T>) {
  if (query.data !== undefined && isNotPermitted(query.data)) return null;
  const headingId = `panel-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  let body: ReactNode;
  if (query.isLoading) {
    body = <LoadingState label={`Loading ${what}`} lines={skeletonLines} />;
  } else if (query.isError || query.data === undefined) {
    body = <ErrorState title={loadFailureMessage(query.error, what)} onRetry={() => void query.refetch()} />;
  } else {
    body = children(query.data as T);
  }
  return (
    <section aria-labelledby={headingId} aria-busy={query.isLoading || undefined} className={cn("flex min-w-0 flex-col gap-4 rounded-lg border bg-card p-4 text-card-foreground sm:p-5", className)}>
      <div className="flex items-center justify-between gap-2">
        <h2 id={headingId} className="font-display text-base font-semibold">
          {title}
        </h2>
        {link ? <PanelLink href={link.href}>{link.label}</PanelLink> : null}
      </div>
      {body}
    </section>
  );
}
