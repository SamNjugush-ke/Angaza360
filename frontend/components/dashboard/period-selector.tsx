"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { usePeriod } from "@/lib/dashboard/period";
import { customRangeError, describePeriod, periodFor, presetOf, PRESET_LABEL, type PeriodPreset } from "@/lib/dashboard/periods";
import { businessToday } from "@/lib/datetime";
import { cn } from "@/lib/utils";

const PRESETS: readonly PeriodPreset[] = ["month-to-date", "last-month", "year-to-date", "custom"];

const control =
  "min-h-11 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** The reporting period for every period-driven panel. Changing it refetches them all. */
export function PeriodSelector() {
  const { period, setPeriod } = usePeriod();
  const today = businessToday();
  const [choice, setChoice] = useState<PeriodPreset>(() => presetOf(period, today));
  const [from, setFrom] = useState(period.from);
  const [to, setTo] = useState(period.to);
  const [error, setError] = useState<string | null>(null);
  const ids = { select: useId(), from: useId(), to: useId(), error: useId() };

  function choose(next: PeriodPreset) {
    setChoice(next);
    setError(null);
    if (next !== "custom") setPeriod(periodFor(next, today));
  }

  function apply() {
    const problem = customRangeError(from, to, today);
    setError(problem);
    if (problem === null) setPeriod({ from, to });
  }

  return (
    <div className="flex flex-col gap-2 sm:items-end">
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.select} className="text-xs font-medium text-muted-foreground">
          Period
        </label>
        <select id={ids.select} value={choice} onChange={(event) => choose(event.target.value as PeriodPreset)} className={cn(control, "w-full sm:w-56")}>
          {PRESETS.map((preset) => (
            <option key={preset} value={preset}>
              {PRESET_LABEL[preset]}
            </option>
          ))}
        </select>
      </div>
      {choice === "custom" ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.from} className="text-xs font-medium text-muted-foreground">
              From
            </label>
            <input id={ids.from} type="date" value={from} max={today} onChange={(e) => setFrom(e.target.value)} className={control} aria-describedby={error ? ids.error : undefined} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.to} className="text-xs font-medium text-muted-foreground">
              To
            </label>
            <input id={ids.to} type="date" value={to} max={today} onChange={(e) => setTo(e.target.value)} className={control} aria-describedby={error ? ids.error : undefined} />
          </div>
          <Button type="button" variant="outline" className="min-h-11" onClick={apply}>
            Apply
          </Button>
        </div>
      ) : null}
      {error ? (
        <p id={ids.error} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {describePeriod(period)}
        </p>
      )}
    </div>
  );
}
