"use client";

import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// The small pieces the public account forms share: a labelled text field with its error wired
// to aria-describedby, and the form-level alert.

export interface TextFieldProps extends ComponentPropsWithoutRef<"input"> {
  id: string;
  label: string;
  error?: string;
  hint?: ReactNode;
  optional?: boolean;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { id, label, error, hint, optional = false, className, ...input },
  ref,
) {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {label}
        {optional ? <span className="font-normal text-muted-foreground"> (optional)</span> : null}
      </Label>
      <Input
        ref={ref}
        id={id}
        className={cn("h-11", className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...input}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
});

export function FormAlert({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {children}
    </p>
  );
}

export const UNAVAILABLE = "Service is temporarily unavailable. Please try again shortly.";

/** The `message` of a BFF error body, when there is one. */
export async function messageOf(response: Response): Promise<string | null> {
  const body: unknown = await response.json().catch(() => null);
  return typeof body === "object" && body !== null && "message" in body && typeof body.message === "string" ? body.message : null;
}

/** POSTs JSON to a same-origin BFF route; a network failure resolves to null. */
export async function postJson(url: string, body: unknown): Promise<Response | null> {
  try {
    return await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
}
