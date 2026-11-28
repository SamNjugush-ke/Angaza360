"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { monthToDate, type Period } from "@/lib/datetime";

// The reporting period every period-driven panel reads. Default: the current month to date, in
// Africa/Nairobi business days (the same period the backend dashboard defaults to). The period
// selector (F1-D.1) sets it.

interface PeriodState {
  period: Period;
  setPeriod: (period: Period) => void;
}

const PeriodContext = createContext<PeriodState | null>(null);

export function PeriodProvider({ initial, children }: { initial?: Period; children: ReactNode }) {
  const [period, setPeriod] = useState<Period>(() => initial ?? monthToDate());
  const value = useMemo(() => ({ period, setPeriod }), [period]);
  return <PeriodContext.Provider value={value}>{children}</PeriodContext.Provider>;
}

export function usePeriod(): PeriodState {
  const state = useContext(PeriodContext);
  if (state === null) throw new Error("usePeriod() must be used inside <PeriodProvider>.");
  return state;
}
