import { pctDelta } from "@/lib/datetime";
import { parseCents } from "@/lib/money";
import type { DashboardSummary } from "./types";

// Period-over-period change for each dashboard figure: the current period against its FAIR
// comparison (datetime.comparisonPeriodOf — chosen by the period's kind).
// Money is compared as BigInt cents (parseCents) and only the RESULT, a percentage, is a number;
// pctDelta is null when the baseline is ≤ 0 (a change from nothing, or from a loss, has no
// meaningful percentage).

export const DELTA_FIGURES = [
  "revenue",
  "costOfSales",
  "grossProfit",
  "operatingExpenses",
  "netProfit",
  "cashPosition",
  "receivables",
  "payables",
] as const;
export type DeltaFigure = (typeof DELTA_FIGURES)[number];

export type DashboardDeltas = Record<DeltaFigure, number | null>;

function figureOf(summary: DashboardSummary, figure: DeltaFigure): bigint {
  return parseCents(figure === "cashPosition" ? summary.cashPosition.total : summary[figure]);
}

export function computeDeltas(current: DashboardSummary, baseline: DashboardSummary): DashboardDeltas {
  const deltas = {} as DashboardDeltas;
  for (const figure of DELTA_FIGURES) {
    deltas[figure] = pctDelta(figureOf(current, figure), figureOf(baseline, figure));
  }
  return deltas;
}
