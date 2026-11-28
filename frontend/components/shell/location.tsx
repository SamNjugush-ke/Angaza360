"use client";

import { MapPin } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { apiFetch } from "@/lib/api/browser";
import type { components } from "@/lib/api/schema";
import { readSelectedLocation, resolveSelection, writeSelectedLocation } from "@/lib/location/selection";
import { cn } from "@/lib/utils";

// The working location within THIS business, loaded once from GET /v1/locations (through the
// BFF) and shared by every selector in the shell and by F1 screens (useWorkingLocation).

export type Location = components["schemas"]["Location"];

export interface WorkingLocation {
  status: "loading" | "ready" | "error";
  locations: readonly Location[];
  selected: Location | null;
  select: (locationId: string) => void;
  retry: () => void;
}

const WorkingLocationContext = createContext<WorkingLocation | null>(null);

/** The working location, or null where the role cannot read locations. */
export function useWorkingLocation(): WorkingLocation | null {
  return useContext(WorkingLocationContext);
}

export function LocationProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [status, setStatus] = useState<WorkingLocation["status"]>("loading");
  const [locations, setLocations] = useState<readonly Location[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    apiFetch("/locations?activeOnly=true")
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { data: Location[] };
        if (cancelled) return;
        setLocations(body.data);
        setSelectedId(resolveSelection(body.data, readSelectedLocation(document.cookie))?.id ?? null);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, attempt]);

  const select = useCallback((locationId: string) => {
    setSelectedId(locationId);
    writeSelectedLocation(locationId);
  }, []);
  const retry = useCallback(() => {
    setStatus("loading");
    setAttempt((n) => n + 1);
  }, []);

  const value = useMemo<WorkingLocation>(
    () => ({ status, locations, selected: locations.find((l) => l.id === selectedId) ?? null, select, retry }),
    [status, locations, selectedId, select, retry],
  );

  if (!enabled) return <>{children}</>;
  return <WorkingLocationContext.Provider value={value}>{children}</WorkingLocationContext.Provider>;
}

/** The location dropdown: "bar" on the desktop top bar, "chip" on the mobile top bar. */
export function LocationSelector({ variant }: { variant: "bar" | "chip" }) {
  const location = useWorkingLocation();
  const id = useId();
  if (!location) return null;

  if (location.status === "loading") return <LoadingState size="inline" label="Loading locations" />;
  if (location.status === "error") {
    return <ErrorState size="inline" title="Couldn’t load locations" onRetry={location.retry} />;
  }
  if (location.locations.length === 0) return <EmptyState size="inline" icon={MapPin} title="No locations yet" />;

  return (
    <div className={cn("relative flex items-center", variant === "chip" ? "max-w-[12rem]" : "w-56")}>
      <label htmlFor={id} className="sr-only">
        Location
      </label>
      <MapPin className="pointer-events-none absolute left-3 size-4 text-muted-foreground" aria-hidden />
      <select
        id={id}
        value={location.selected?.id ?? ""}
        onChange={(event) => location.select(event.target.value)}
        className={cn(
          "min-h-11 w-full appearance-none border border-input bg-background pl-9 pr-3 text-sm font-medium",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          variant === "chip" ? "rounded-full" : "rounded-md",
        )}
      >
        {location.locations.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
    </div>
  );
}
