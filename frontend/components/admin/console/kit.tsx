"use client";

import Link from "next/link";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { TextField } from "@/components/auth/form-bits";
import { Button } from "@/components/ui/button";
import { stepUp } from "@/lib/admin/console";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { formatDateTime } from "@/lib/datetime";
import { cn } from "@/lib/utils";

// THE COMMAND CENTER'S KIT (M4.5 W5). A console reads as one instrument panel: hairline-ruled
// panels instead of floating cards, figures in IBM Plex Mono, state carried by a small square mark
// AND a word (never colour alone), and every panel naming where its detail lives. Times are
// Africa/Nairobi. The step-up prompt is the one way a SUPER_ADMIN confirms a sensitive action.

export type Tone = "ok" | "warn" | "bad" | "idle";

const TONE_MARK: Readonly<Record<Tone, string>> = {
  ok: "bg-success",
  warn: "bg-angaza-gold",
  bad: "bg-destructive",
  idle: "bg-muted-foreground/40",
};

/** A square status mark beside its word: colour is never the only signal. */
export function StatusMark({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", className)}>
      <span aria-hidden className={cn("size-2 shrink-0 rounded-[2px]", TONE_MARK[tone])} />
      {children}
    </span>
  );
}

export const runTone = (status: string | null | undefined): Tone =>
  status === "SUCCEEDED" ? "ok" : status === "FAILED" ? "bad" : status === "SKIPPED" || status === "RUNNING" ? "warn" : "idle";
export const healthTone = (status: string | null | undefined): Tone => (status === "HEALTHY" ? "ok" : status === "FAILING" ? "bad" : "idle");

/** A titled panel with an optional "see all" link to its detail screen. */
export function Panel({ title, href, linkLabel, children, className, description }: { title: string; href?: string; linkLabel?: string; children: ReactNode; className?: string; description?: string }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={cn("rounded-lg border bg-card", className)}>
      <header className="flex items-baseline justify-between gap-3 border-b px-4 py-2.5">
        <div>
          <h2 id={headingId} className="font-display text-sm font-semibold tracking-tight">
            {title}
          </h2>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {href ? (
          <Link href={href} className="min-h-11 shrink-0 content-center text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {linkLabel ?? "Open"}
          </Link>
        ) : null}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** A figure set in the mono face, tabular. */
export function Figure({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-mono tabular-nums", className)}>{children}</span>;
}

/** "3 h ago" for an instant, with the full Nairobi time in a tooltip and for screen readers. */
export function Ago({ at, now = new Date() }: { at: string | null | undefined; now?: Date }) {
  if (!at) return <span className="text-muted-foreground">never</span>;
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(at).getTime()) / 60_000));
  const words = minutes < 1 ? "just now" : minutes < 60 ? `${minutes.toString()} min ago` : minutes < 48 * 60 ? `${Math.round(minutes / 60).toString()} h ago` : `${Math.round(minutes / 1440).toString()} d ago`;
  return (
    <time dateTime={at} title={formatDateTime(at)}>
      {words}
    </time>
  );
}

export const isStepUpRequired = (error: unknown) => error instanceof ApiHttpError && error.code === "StepUpRequired";

/**
 * Runs a sensitive action; if the API asks for a fresh step-up, shows the code prompt and, once
 * confirmed, runs the SAME action again (the caller keeps its idempotency key, so a retry is the
 * same request). Returns the controls and the prompt to render.
 */
export function useStepUp() {
  const [pending, setPending] = useState<null | (() => Promise<void>)>(null);
  async function guard(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (isStepUpRequired(error)) {
        setPending(() => action);
        return;
      }
      throw error;
    }
  }
  const prompt = pending ? (
    <StepUpPrompt
      onCancel={() => setPending(null)}
      onConfirmed={async () => {
        const again = pending;
        setPending(null);
        await again();
      }}
    />
  ) : null;
  return { guard, prompt };
}

function StepUpPrompt({ onCancel, onConfirmed }: { onCancel: () => void; onConfirmed: () => Promise<void> }) {
  const codeId = useId();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    // Never let the confirmation submit an enclosing form as well (that would send the action twice).
    event.stopPropagation();
    setBusy(true);
    setError(null);
    try {
      await stepUp(code.trim());
    } catch (failure) {
      setBusy(false);
      setError(failure instanceof Error ? failure.message : "That code was not accepted.");
      return;
    }
    try {
      await onConfirmed();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That could not be done.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form role="dialog" aria-label="Confirm it is you" onSubmit={(e) => void submit(e)} className="space-y-3 rounded-lg border border-primary/40 bg-primary/5 p-4">
      <p className="text-sm font-medium">Confirm it is you</p>
      <p className="text-sm text-muted-foreground">This action needs a fresh code from your authenticator app. It stays confirmed for five minutes.</p>
      <TextField id={codeId} label="Authenticator code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button type="button" variant="outline" className="h-11" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" className="h-11" disabled={busy || code.trim() === ""}>
          {busy ? "Confirming…" : "Confirm and continue"}
        </Button>
      </div>
    </form>
  );
}
