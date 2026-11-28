import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDebounced } from "@/lib/catalog/hooks";
import { fetchCurrentShift, fetchCustomers, fetchShiftSummary, fetchStkStatus, quoteSale } from "./api";
import type { QuoteBody } from "./types";

// The till's queries. The QUOTE is the authority on every figure the cashier sees and takes
// payment against: it is re-asked (debounced) whenever the cart, the customer or the location
// changes, and the previous answer stays on screen while the next one loads.

export const posKeys = {
  all: ["pos"] as const,
  currentShift: () => ["pos", "shift", "current"] as const,
  shiftSummary: (shiftId: string) => ["pos", "shift", shiftId] as const,
  quote: (body: QuoteBody) => ["pos", "quote", body] as const,
  customers: () => ["pos", "customers"] as const,
  stk: (checkoutRequestId: string) => ["pos", "mpesa", checkoutRequestId] as const,
  sale: (saleId: string) => ["pos", "sale", saleId] as const,
  receipt: (saleId: string) => ["pos", "receipt", saleId] as const,
  shiftSales: (shiftId: string) => ["pos", "shift-sales", shiftId] as const,
};

/**
 * How often the till asks M-Pesa's answer, and how long it waits before saying nobody has
 * answered. TIMED_OUT is written by the server's sweep, which may run long after the customer
 * walked away — so the till stops waiting on its own and offers the way forward instead.
 */
export const stkTiming = { pollMs: 2000, quietAfterMs: 90_000 };

/** The cashier's open shift — asked only once there is a location to sell from. */
export function useCurrentShift(enabled = true) {
  return useQuery({ queryKey: posKeys.currentShift(), queryFn: fetchCurrentShift, staleTime: 0, enabled });
}

export function useShiftSummary(shiftId: string | null) {
  return useQuery({
    queryKey: posKeys.shiftSummary(shiftId ?? ""),
    queryFn: () => fetchShiftSummary(shiftId ?? ""),
    enabled: shiftId !== null,
    staleTime: 0,
  });
}

/**
 * The live quote for what is in the cart, or idle while the cart is empty or invalid. `isCurrent`
 * is true only when the quote on hand answers EXACTLY the body asked now — not a previous cart
 * still shown while the next one is debounced or loading. Payment is taken only against a current
 * quote, so the till never charges a total the cart has already moved away from.
 */
export function useQuote(body: QuoteBody | null) {
  const asked = body === null ? null : JSON.stringify(body);
  const settled = useDebounced(asked, 250);
  const parsed = settled === null ? null : (JSON.parse(settled) as QuoteBody);
  const query = useQuery({
    queryKey: posKeys.quote(parsed ?? ({ lines: [] } as unknown as QuoteBody)),
    queryFn: () => quoteSale(parsed as QuoteBody),
    enabled: parsed !== null,
    placeholderData: keepPreviousData,
    staleTime: 0,
    retry: false,
  });
  const isCurrent = asked !== null && settled === asked && query.isSuccess && !query.isPlaceholderData && !query.isFetching;
  return { ...query, isCurrent };
}

export function useCustomers() {
  return useQuery({ queryKey: posKeys.customers(), queryFn: fetchCustomers });
}

/** Polls an STK prompt while the till is waiting on it; idle otherwise. */
export function useStkStatus(checkoutRequestId: string | null, waiting: boolean) {
  return useQuery({
    queryKey: posKeys.stk(checkoutRequestId ?? ""),
    queryFn: () => fetchStkStatus(checkoutRequestId ?? ""),
    enabled: checkoutRequestId !== null && waiting,
    refetchInterval: waiting ? stkTiming.pollMs : false,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}
