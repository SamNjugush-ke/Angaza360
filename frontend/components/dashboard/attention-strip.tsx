"use client";

import { AlertTriangle, CheckCircle2, FileWarning, PackageMinus, Receipt } from "lucide-react";
import Link from "next/link";
import type { AttentionItem, AttentionKey } from "@/lib/dashboard/attention";
import type { LucideIcon } from "lucide-react";

const ICON: Readonly<Record<AttentionKey, LucideIcon>> = {
  "overdue-receivables": AlertTriangle,
  "low-stock": PackageMinus,
  tax: Receipt,
  etims: FileWarning,
};

/** What needs attention now; a quiet "All clear" when nothing does. */
export function AttentionStrip({ items, loading }: { items: AttentionItem[]; loading: boolean }) {
  if (items.length === 0) {
    if (loading) return null;
    return (
      <p role="status" className="flex min-h-11 items-center gap-2 rounded-lg border bg-card px-4 text-sm text-muted-foreground">
        <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
        All clear — nothing needs your attention right now.
      </p>
    );
  }
  return (
    <section aria-labelledby="attention-title">
      <h2 id="attention-title" className="sr-only">
        Needs attention
      </h2>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {items.map((item) => {
          const Icon = ICON[item.key];
          return (
            <li key={item.key} className="flex flex-col gap-2 rounded-lg border border-l-4 border-l-warning bg-card p-4">
              <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Icon className="size-4 shrink-0 text-warning" aria-hidden />
                {item.title}
              </p>
              <p className="tabular font-display text-xl font-semibold">{item.figure}</p>
              <p className="text-sm text-muted-foreground">{item.detail}</p>
              {item.action ? (
                <Link
                  href={item.action.href}
                  className="mt-auto inline-flex min-h-11 items-center self-start rounded-md text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {item.action.label}
                </Link>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
