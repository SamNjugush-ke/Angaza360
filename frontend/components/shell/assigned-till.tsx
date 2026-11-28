"use client";

import { MapPin } from "lucide-react";
import { useMyLocation } from "@/lib/allocations/allocations";
import { cn } from "@/lib/utils";

/**
 * A CASHIER's top-bar location (M4.5 W3): the till they are assigned, as context — not a selector,
 * because a cashier sells only from it (the backend refuses anything else).
 */
export function AssignedTill({ variant }: { variant: "bar" | "chip" }) {
  const mine = useMyLocation();
  const name = mine.data?.location?.name;
  const text = mine.isPending ? "Finding your till…" : name ? name : "No till assigned";
  return (
    <p
      className={cn(
        "flex min-h-11 items-center gap-2 border border-input bg-muted/40 px-3 text-sm font-medium",
        variant === "chip" ? "max-w-[12rem] rounded-full" : "w-56 rounded-md",
      )}
    >
      <MapPin className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">
        <span className="sr-only">Your till: </span>
        {text}
      </span>
    </p>
  );
}
