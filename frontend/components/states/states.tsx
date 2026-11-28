import { AlertTriangle, Inbox, Lock, type LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// The three states every data view has besides "ready": loading, empty and error — plus the
// page-level "not authorized" state. Shared by the shell and every F1 screen, so they look and
// announce themselves the same way everywhere.

interface StateProps {
  /** "inline" fits a bar or a control; "block" fills a panel. */
  size?: "inline" | "block";
  className?: string;
}

/** Loading: skeleton bars, announced once to assistive technology. */
export function LoadingState({ label, lines = 3, size = "block", className }: StateProps & { label: string; lines?: number }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className={cn(size === "block" ? "space-y-3" : "flex items-center", className)}>
      <span className="sr-only">{label}</span>
      {size === "inline" ? (
        <Skeleton className="h-11 w-44" />
      ) : (
        Array.from({ length: lines }, (_, i) => <Skeleton key={i} className={cn("h-4", i === lines - 1 ? "w-2/3" : "w-full")} />)
      )}
    </div>
  );
}

/** Empty: nothing exists yet. A title, an optional hint and an optional action. */
export function EmptyState({
  title,
  description,
  action,
  icon: Icon = Inbox,
  size = "block",
  className,
}: StateProps & { title: string; description?: string; action?: ReactNode; icon?: LucideIcon }) {
  if (size === "inline") {
    return (
      <p role="status" className={cn("flex min-h-11 items-center gap-2 text-sm text-muted-foreground", className)}>
        <Icon className="size-4 shrink-0" aria-hidden />
        {title}
      </p>
    );
  }
  return (
    <div role="status" className={cn("flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center", className)}>
      <Icon className="size-8 text-muted-foreground" aria-hidden />
      <p className="font-medium">{title}</p>
      {description ? <p className="max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      {action}
    </div>
  );
}

/** Error: what failed, and a way to try again when there is one. */
export function ErrorState({
  title,
  description,
  onRetry,
  size = "block",
  className,
}: StateProps & { title: string; description?: string; onRetry?: () => void }) {
  const retry = onRetry ? (
    <Button type="button" variant="outline" className="min-h-11" onClick={onRetry}>
      Try again
    </Button>
  ) : null;
  if (size === "inline") {
    return (
      <div role="alert" className={cn("flex min-h-11 items-center gap-2 text-sm text-destructive", className)}>
        <AlertTriangle className="size-4 shrink-0" aria-hidden />
        <span>{title}</span>
        {retry}
      </div>
    );
  }
  return (
    <div role="alert" className={cn("flex flex-col items-center gap-2 rounded-lg border border-destructive/40 p-8 text-center", className)}>
      <AlertTriangle className="size-8 text-destructive" aria-hidden />
      <p className="font-medium">{title}</p>
      {description ? <p className="max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      {retry}
    </div>
  );
}

/**
 * Not authorized (403): the role may not open this section. It replaces the whole page, so it
 * carries the page's one <h1>, and offers the way back to the role's own landing.
 */
export function NotAuthorizedState({ section, homeHref }: { section: string; homeHref: string }) {
  return (
    <section aria-labelledby="not-authorized-title" className="flex flex-col items-center gap-3 rounded-lg border p-8 text-center">
      <Lock className="size-8 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium text-muted-foreground">403 · Not authorized</p>
      <h1 id="not-authorized-title" className="font-display text-xl font-semibold">
        You don’t have access to {section}
      </h1>
      <p className="max-w-sm text-sm text-muted-foreground">Your role doesn’t include this section.</p>
      <Link href={homeHref} className="inline-flex min-h-11 items-center rounded-md border border-input px-4 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Go to your home
      </Link>
    </section>
  );
}
