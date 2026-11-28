import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/** A pulsing placeholder for content that is loading. Decorative: the caller announces the load. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden className={cn("animate-pulse rounded-md bg-muted motion-reduce:animate-none", className)} {...props} />;
}
