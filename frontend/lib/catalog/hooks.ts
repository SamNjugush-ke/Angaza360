import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { fetchCategories, fetchProducts } from "./api";
import { PAGE_SIZE, type ProductFilters } from "./types";

// The catalog's queries. The list key carries every filter and the page, so a change is a new
// cache entry; the previous page stays on screen while the next loads (no flash of empty).
// Every write invalidates the whole "catalog" family — the list and the category options.

export const catalogKeys = {
  all: ["catalog"] as const,
  list: (filters: ProductFilters, page: number) => ["catalog", "list", filters, page] as const,
  categories: () => ["catalog", "categories"] as const,
};

export function useProducts(filters: ProductFilters, page: number) {
  return useQuery({
    queryKey: catalogKeys.list(filters, page),
    queryFn: () => fetchProducts(filters, page * PAGE_SIZE, PAGE_SIZE),
    placeholderData: keepPreviousData,
  });
}

export function useCategories() {
  return useQuery({ queryKey: catalogKeys.categories(), queryFn: fetchCategories });
}

/** After any catalog write: refetch the list and the category options. */
export function useInvalidateCatalog(): () => Promise<void> {
  const client = useQueryClient();
  return useCallback(() => client.invalidateQueries({ queryKey: catalogKeys.all }), [client]);
}

/** `value`, settled for `delayMs` — the search box queries the server only once typing pauses. */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}
