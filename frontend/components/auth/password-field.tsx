"use client";

import { Eye, EyeOff } from "lucide-react";
import { forwardRef, useId, useState, type ComponentPropsWithoutRef } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MIN_PASSWORD_LENGTH, passwordStrength, STRENGTH_LABEL, type PasswordStrength } from "@/lib/auth/password-strength";
import { cn } from "@/lib/utils";

// A new-password field: show/hide, the 10-character rule stated up front, and a live strength
// hint announced politely. Registered with react-hook-form through the forwarded ref and props.

const BAR: Readonly<Record<PasswordStrength, { filled: number; tone: string }>> = {
  "too-short": { filled: 1, tone: "bg-destructive" },
  fair: { filled: 2, tone: "bg-amber-600 dark:bg-amber-400" },
  good: { filled: 3, tone: "bg-primary" },
  strong: { filled: 4, tone: "bg-emerald-700 dark:bg-emerald-400" },
};

export interface PasswordFieldProps extends Omit<ComponentPropsWithoutRef<"input">, "type"> {
  label: string;
  /** The current value, for the strength hint. */
  value: string;
  error?: string;
  /** Show the strength hint (a new password) or not (a confirmation). */
  showStrength?: boolean;
}

export const PasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(function PasswordField(
  { label, value, error, showStrength = true, id: givenId, className, ...input },
  ref,
) {
  const fallbackId = useId();
  const id = givenId ?? fallbackId;
  const [shown, setShown] = useState(false);
  const strength = passwordStrength(value);
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [showStrength ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          ref={ref}
          id={id}
          type={shown ? "text" : "password"}
          autoComplete="new-password"
          className={cn("h-11 pr-12", className)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          {...input}
        />
        <button
          type="button"
          onClick={() => setShown((now) => !now)}
          aria-label={shown ? "Hide password" : "Show password"}
          aria-pressed={shown}
          aria-controls={id}
          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {shown ? <EyeOff className="size-5" aria-hidden /> : <Eye className="size-5" aria-hidden />}
        </button>
      </div>
      {showStrength ? (
        <div id={hintId} className="space-y-1.5">
          <div className="flex gap-1" aria-hidden>
            {[0, 1, 2, 3].map((slot) => (
              <span
                key={slot}
                className={cn("h-1.5 flex-1 rounded-full", value.length > 0 && slot < BAR[strength].filled ? BAR[strength].tone : "bg-muted")}
              />
            ))}
          </div>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {value.length > 0 ? <span className="font-medium text-foreground">{STRENGTH_LABEL[strength]}. </span> : null}
            At least {MIN_PASSWORD_LENGTH} characters. Longer is stronger — a few unrelated words work well.
          </p>
        </div>
      ) : null}
      {error ? (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
});
