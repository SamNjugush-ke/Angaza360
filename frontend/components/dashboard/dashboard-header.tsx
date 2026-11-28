"use client";

import { useWorkingLocation } from "@/components/shell/location";
import { greetingLine } from "@/components/shell/greeting";
import { PeriodSelector } from "./period-selector";

/** The greeting to the PERSON (first name, Nairobi clock); the business and location are context beneath it. */
export function DashboardHeader({ fullName, businessName, showPeriod }: { fullName: string; businessName: string; showPeriod: boolean }) {
  const location = useWorkingLocation();
  const place = location?.selected?.name;
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-1">
        {/* The greeting follows the clock: the server and the browser may straddle an hour. */}
        <h1 className="font-display text-2xl font-semibold" suppressHydrationWarning>
          {greetingLine(fullName)}
        </h1>
        <p className="text-sm text-muted-foreground">
          {businessName}
          {place ? ` · ${place}` : ""}
          {showPeriod ? " · Figures for the whole business" : ""}
        </p>
      </div>
      {showPeriod ? <PeriodSelector /> : null}
    </header>
  );
}
