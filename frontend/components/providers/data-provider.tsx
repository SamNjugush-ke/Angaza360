"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { PeriodProvider } from "@/lib/dashboard/period";
import { makeQueryClient } from "@/lib/dashboard/query-client";

/** The authenticated area's data layer: one QueryClient per browser session, and the period. */
export function DataProvider({ children }: { children: ReactNode }) {
  // One client for the life of the shell — never shared across requests or users.
  const [client] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={client}>
      <PeriodProvider>{children}</PeriodProvider>
    </QueryClientProvider>
  );
}
