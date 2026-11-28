"use client";

import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// Toasts: short, non-blocking notices. ONE polite live region, present from the first render
// (a region added at the same moment as its text is often not announced), so a toast is read
// out without moving focus. Each toast can be dismissed by its button or with Escape while
// focus is inside it, and pauses its timer while hovered or focused. Motion is applied only
// under prefers-reduced-motion: no-preference (motion-safe:).

export type ToastTone = "info" | "success" | "error";

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Milliseconds before it dismisses itself; null keeps it until dismissed. */
  duration?: number | null;
}

interface ToastEntry extends Required<Pick<ToastOptions, "title" | "tone">> {
  id: number;
  description?: string;
  duration: number | null;
}

export interface ToastApi {
  toast: (options: ToastOptions) => number;
  /** The generic notice for an action that failed. */
  failure: (description?: string) => number;
  dismiss: (id: number) => void;
}

export const DEFAULT_TOAST_MS = 6000;
export const FAILURE_TITLE = "Something went wrong";

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast() must be used inside <ToastProvider>.");
  return api;
}

const ICON = { info: Info, success: CheckCircle2, error: AlertTriangle } as const;

function ToastItem({ entry, onDismiss }: { entry: ToastEntry; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  const Icon = ICON[entry.tone];

  useEffect(() => {
    if (entry.duration === null || paused) return;
    const timer = setTimeout(() => onDismiss(entry.id), entry.duration);
    return () => clearTimeout(timer);
  }, [entry.id, entry.duration, paused, onDismiss]);

  return (
    <div
      data-tone={entry.tone}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onDismiss(entry.id);
      }}
      className={cn(
        "pointer-events-auto flex w-full items-start gap-3 rounded-lg border bg-card p-4 text-card-foreground shadow-lg",
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2",
        entry.tone === "error" && "border-destructive/50",
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 size-5 shrink-0",
          entry.tone === "error" ? "text-destructive" : entry.tone === "success" ? "text-success" : "text-primary",
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{entry.title}</p>
        {entry.description ? <p className="mt-0.5 text-sm text-muted-foreground">{entry.description}</p> : null}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(entry.id)}
        aria-label={`Dismiss: ${entry.title}`}
        className="-m-2 flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<ToastEntry[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setEntries((list) => list.filter((entry) => entry.id !== id)), []);
  const toast = useCallback((options: ToastOptions) => {
    const id = nextId.current++;
    const entry: ToastEntry = {
      id,
      title: options.title,
      description: options.description,
      tone: options.tone ?? "info",
      duration: options.duration === undefined ? DEFAULT_TOAST_MS : options.duration,
    };
    // Newest last (reading order); at most three on screen.
    setEntries((list) => [...list, entry].slice(-3));
    return id;
  }, []);
  const failure = useCallback(
    (description = "Please try again.") => toast({ title: FAILURE_TITLE, description, tone: "error" }),
    [toast],
  );

  const api = useMemo<ToastApi>(() => ({ toast, failure, dismiss }), [toast, failure, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <section
        aria-label="Notifications"
        className="pointer-events-none fixed inset-x-4 bottom-24 z-[60] lg:bottom-6 lg:left-auto lg:right-6 lg:w-96"
      >
        <div role="status" aria-live="polite" aria-relevant="additions text" className="flex flex-col gap-2">
          {entries.map((entry) => (
            <ToastItem key={entry.id} entry={entry} onDismiss={dismiss} />
          ))}
        </div>
      </section>
    </ToastContext.Provider>
  );
}
