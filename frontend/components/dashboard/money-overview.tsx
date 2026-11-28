"use client";

import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/states/states";
import { actionFor } from "@/lib/dashboard/attention";
import { deltaDisplay, type DeltaDirection } from "@/lib/dashboard/delta-display";
import type { DashboardDeltas } from "@/lib/dashboard/deltas";
import type { DashboardSummary } from "@/lib/dashboard/types";
import type { Role } from "@/lib/auth/landing";
import { formatKES, parseCents } from "@/lib/money";
import { cn } from "@/lib/utils";

const TONE: Readonly<Record<DeltaDirection, string>> = {
  up: "text-success",
  down: "text-destructive",
  flat: "text-muted-foreground",
  none: "text-muted-foreground",
};
const ARROW = { up: ArrowUpRight, down: ArrowDownRight, flat: Minus, none: Minus } as const;

/** A change on the comparison period: sign, arrow and words together — never colour alone. */
export interface ComparedWith {
  /** "last month", "last year", "previous period"… */
  label: string;
  /** The comparison's dates, compactly. */
  range: string;
}

export function DeltaBadge({ delta, comparedWith }: { delta: number | null | undefined; comparedWith: ComparedWith }) {
  const display = deltaDisplay(delta, `${comparedWith.label} (${comparedWith.range})`);
  const Arrow = ARROW[display.direction];
  return (
    <div className="space-y-0.5">
      <p className={cn("flex items-center gap-1 text-sm font-medium", TONE[display.direction])}>
        <Arrow className="size-4 shrink-0" aria-hidden />
        <span aria-hidden className="tabular">
          {display.text}
        </span>
        <span className="sr-only">{display.description}</span>
      </p>
      {display.direction !== "none" ? (
        <p aria-hidden className="text-xs text-muted-foreground">
          vs {comparedWith.label} · {comparedWith.range}
        </p>
      ) : null}
    </div>
  );
}

function Figure({ label, cents, size }: { label: string; cents: string; size: "lead" | "secondary" }) {
  return (
    <div className="min-w-0">
      <p className="text-sm text-muted-foreground">{label}</p>
      {/* The currency as a quiet prefix, so a large figure never wraps. */}
      <p
        className={cn(
          "tabular whitespace-nowrap font-display font-semibold",
          size === "lead" ? "text-2xl sm:text-3xl xl:text-2xl 2xl:text-3xl" : "text-lg",
        )}
      >
        <span className="text-sm font-medium text-muted-foreground">KES </span>
        {formatKES(cents)}
      </p>
    </div>
  );
}

interface MoneyOverviewProps {
  role: Role;
  summary: DashboardSummary;
  /** undefined while the comparison loads, or when it is unavailable. */
  deltas: DashboardDeltas | undefined;
  comparedWith: ComparedWith;
}

/** Revenue and net profit lead, each with its change; gross profit and operating expenses follow. */
export function MoneyOverview({ role, summary, deltas, comparedWith }: MoneyOverviewProps) {
  const quiet =
    parseCents(summary.revenue) === 0n && parseCents(summary.costOfSales) === 0n && parseCents(summary.operatingExpenses) === 0n;
  if (quiet) {
    const record = actionFor(role, "Record a sale", "/pos");
    return record ? (
      <EmptyState
        title="No sales yet this period"
        description="Record your first sale and your figures appear here."
        action={
          <Link
            href={record.href}
            className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {record.label}
          </Link>
        }
      />
    ) : (
      <EmptyState title="No activity this period" />
    );
  }
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <div className="space-y-1">
        <Figure label="Revenue" cents={summary.revenue} size="lead" />
        <DeltaBadge delta={deltas?.revenue} comparedWith={comparedWith} />
      </div>
      <div className="space-y-1">
        <Figure label="Net profit" cents={summary.netProfit} size="lead" />
        <DeltaBadge delta={deltas?.netProfit} comparedWith={comparedWith} />
      </div>
      <Figure label="Gross profit" cents={summary.grossProfit} size="secondary" />
      <Figure label="Operating expenses" cents={summary.operatingExpenses} size="secondary" />
    </div>
  );
}
