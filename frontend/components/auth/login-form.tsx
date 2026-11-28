"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Eye, EyeOff } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoginSteps, type ChallengeStep } from "@/components/auth/login-steps";
import { landingFor, type Role } from "@/lib/auth/landing";

// The sign-in form. It posts to the BFF (/api/auth/login), which sets the HttpOnly session
// cookies; the browser receives only who signed in — never a token. Since M4.5 Wave 1 a correct
// password may answer with the next step instead (two-step verification, a forced new password,
// an administrator's MFA set-up); <LoginSteps> carries the sign-in through it.

const loginSchema = z.object({
  email: z.string().trim().min(1, "Enter your email address.").pipe(z.email("Enter a valid email address.")),
  password: z.string().min(1, "Enter your password."),
  remember: z.boolean(),
});

type LoginValues = z.infer<typeof loginSchema>;

const INVALID_CREDENTIALS = "Invalid email or password.";
const UNAVAILABLE = "Service is temporarily unavailable. Please try again shortly.";

async function messageFor(response: Response): Promise<string> {
  if (response.status === 401) return INVALID_CREDENTIALS;
  // A refused account (inactive business) or a throttle carries a message meant for the user.
  if (response.status === 403 || response.status === 429) {
    const body: unknown = await response.json().catch(() => null);
    if (typeof body === "object" && body !== null && "message" in body && typeof body.message === "string") {
      return body.message;
    }
  }
  return UNAVAILABLE;
}

export interface LoginFormProps {
  /** A validated, same-site path to return to after signing in. */
  returnTo: string | null;
}

export function LoginForm({ returnTo }: LoginFormProps) {
  const router = useRouter();
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // Stays true once signed in, so the button cannot resubmit while the next page loads.
  const [navigating, setNavigating] = useState(false);
  const [step, setStep] = useState<ChallengeStep | null>(null);
  const ids = { email: useId(), password: useId(), form: useId() };
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "", remember: false },
  });

  async function onSubmit(values: LoginValues) {
    setFormError(null);
    let response: Response;
    try {
      response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values),
      });
    } catch {
      setFormError(UNAVAILABLE);
      return;
    }
    if (!response.ok) {
      setFormError(await messageFor(response));
      return;
    }
    const answer = (await response.json()) as { status?: string; role?: Role };
    if (answer.status === "MFA_REQUIRED" || answer.status === "PASSWORD_RESET_REQUIRED" || answer.status === "MFA_ENROLLMENT_REQUIRED") {
      setStep(answer.status);
      return;
    }
    if (answer.role === undefined) {
      setFormError(UNAVAILABLE);
      return;
    }
    signedIn(answer.role);
  }

  function signedIn(role: Role) {
    setNavigating(true);
    router.push(landingFor(role, returnTo));
  }

  const busy = isSubmitting || navigating;

  if (step !== null) {
    return (
      <LoginSteps
        initial={step}
        onSignedIn={signedIn}
        onRestart={(message) => {
          setStep(null);
          setFormError(message);
        }}
      />
    );
  }

  return (
    <form
      noValidate
      aria-describedby={formError ? ids.form : undefined}
      onSubmit={handleSubmit(onSubmit)}
      className="space-y-5"
    >
      {formError ? (
        <p id={ids.form} role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {formError}
        </p>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor={ids.email}>Email address</Label>
        <Input
          id={ids.email}
          type="email"
          autoComplete="email"
          inputMode="email"
          className="h-11"
          aria-invalid={errors.email ? true : undefined}
          aria-describedby={errors.email ? `${ids.email}-error` : undefined}
          {...register("email")}
        />
        {errors.email ? (
          <p id={`${ids.email}-error`} className="text-sm text-destructive">
            {errors.email.message}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={ids.password}>Password</Label>
          <Link
            href="/forgot"
            className="inline-flex min-h-11 items-center rounded-sm text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Forgot password?
          </Link>
        </div>
        <div className="relative">
          <Input
            id={ids.password}
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            className="h-11 pr-12"
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={errors.password ? `${ids.password}-error` : undefined}
            {...register("password")}
          />
          <button
            type="button"
            onClick={() => setShowPassword((shown) => !shown)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            aria-pressed={showPassword}
            aria-controls={ids.password}
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {showPassword ? <EyeOff className="size-5" aria-hidden /> : <Eye className="size-5" aria-hidden />}
          </button>
        </div>
        {errors.password ? (
          <p id={`${ids.password}-error`} className="text-sm text-destructive">
            {errors.password.message}
          </p>
        ) : null}
      </div>

      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
        <input
          type="checkbox"
          className="size-5 rounded border-input accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          {...register("remember")}
        />
        Keep me signed in
      </label>

      <Button type="submit" className="h-11 w-full" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
