"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { Role } from "@/lib/auth/landing";
import { PRODUCT_NAME } from "@/lib/brand";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password-strength";
import { ROLE_LABEL } from "@/lib/nav/roles";
import { LINK_CLASS } from "./auth-page";
import { FormAlert, messageOf, postJson, TextField, UNAVAILABLE } from "./form-bits";
import { PasswordField } from "./password-field";

// Accepting an invitation, through the BFF (which sets no cookie): first what the invitation
// offers (the email, the role, the business), then a name and a password. Accepting creates the
// account and signs nobody in, so we go to /login with a welcome notice. An unknown, used,
// revoked or expired invitation is ONE answer from the backend, shown as one state here.

export interface InvitationPreview {
  email: string;
  role: Role;
  businessName: string | null;
  expiresAt: string;
}

type Load = { kind: "loading" } | { kind: "ready"; invitation: InvitationPreview } | { kind: "invalid"; message: string } | { kind: "error" };

export const INVALID_INVITATION = "This invitation is invalid or has expired. Ask the person who invited you for a new one.";

const acceptSchema = z
  .object({
    fullName: z.string().trim().min(1, "Enter your full name.").max(200, "At most 200 characters."),
    password: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH.toString()} characters.`),
    confirmPassword: z.string().min(1, "Type the password again."),
  })
  .refine((values) => values.password === values.confirmPassword, { path: ["confirmPassword"], message: "The two passwords do not match." });

type AcceptValues = z.infer<typeof acceptSchema>;

const bffPath = (token: string) => `/api/users/invitations/${encodeURIComponent(token)}`;

function AcceptForm({ token, invitation, onInvalid }: { token: string; invitation: InvitationPreview; onInvalid: (message: string) => void }) {
  const router = useRouter();
  const ids = { email: useId(), fullName: useId(), password: useId(), confirm: useId(), form: useId() };
  const [formError, setFormError] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);
  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
  } = useForm<AcceptValues>({ resolver: zodResolver(acceptSchema), defaultValues: { fullName: "", password: "", confirmPassword: "" } });

  async function onSubmit({ fullName, password }: AcceptValues) {
    setFormError(null);
    const response = await postJson(`${bffPath(token)}/accept`, { fullName, password });
    if (response === null) return setFormError(UNAVAILABLE);
    if (response.status === 201) {
      setNavigating(true);
      router.push("/login?reason=welcome");
      return;
    }
    const message = await messageOf(response);
    // A 400 is the invitation itself (used, revoked or expired since the page loaded) — unless it
    // is the password policy, which the user can fix here.
    if (response.status === 400 && message && !/password/i.test(message)) return onInvalid(message);
    setFormError((response.status === 400 || response.status === 409 || response.status === 429) && message ? message : UNAVAILABLE);
  }

  const [password, confirmPassword] = useWatch({ control, name: ["password", "confirmPassword"] });
  const busy = isSubmitting || navigating;
  const where = invitation.businessName ?? PRODUCT_NAME;

  return (
    <div className="space-y-5">
      <p className="text-base">
        You’ve been invited to join <span className="font-semibold">{where}</span> as{" "}
        <span className="font-semibold">{ROLE_LABEL[invitation.role]}</span>.
      </p>
      <form noValidate onSubmit={handleSubmit(onSubmit)} aria-describedby={formError ? ids.form : undefined} className="space-y-5">
        {formError ? <FormAlert id={ids.form}>{formError}</FormAlert> : null}
        <TextField id={ids.email} label="Email address" type="email" value={invitation.email} readOnly autoComplete="username" hint="You’ll sign in with this email." />
        <TextField id={ids.fullName} label="Your full name" autoComplete="name" error={errors.fullName?.message} {...register("fullName")} />
        <PasswordField id={ids.password} label="Choose a password" value={password} error={errors.password?.message} {...register("password")} />
        <PasswordField
          id={ids.confirm}
          label="Confirm password"
          value={confirmPassword}
          showStrength={false}
          error={errors.confirmPassword?.message}
          {...register("confirmPassword")}
        />
        <Button type="submit" className="h-11 w-full" disabled={busy}>
          {busy ? "Creating your account…" : "Accept invitation"}
        </Button>
      </form>
    </div>
  );
}

/** What the BFF says about the invitation, as a page state. Pure: it sets no React state. */
export async function loadInvitation(token: string): Promise<Load> {
  let response: Response;
  try {
    response = await fetch(bffPath(token), { credentials: "same-origin", cache: "no-store" });
  } catch {
    return { kind: "error" };
  }
  if (response.ok) return { kind: "ready", invitation: (await response.json()) as InvitationPreview };
  if (response.status === 400) return { kind: "invalid", message: INVALID_INVITATION };
  return { kind: "error" };
}

export function InviteAccept({ token }: { token: string }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    void loadInvitation(token).then((next) => {
      if (current) setLoad(next);
    });
    return () => {
      current = false;
    };
  }, [token, attempt]);

  if (load.kind === "loading") {
    return (
      <div aria-busy="true" aria-live="polite" className="space-y-4">
        <span className="sr-only">Checking your invitation…</span>
        <Skeleton className="h-6 w-3/4" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
      </div>
    );
  }
  if (load.kind === "invalid") {
    return (
      <div role="alert" className="space-y-3">
        <p className="font-medium">{load.message}</p>
        <p className="text-sm text-muted-foreground">
          Already accepted it?{" "}
          <Link href="/login" className={LINK_CLASS}>
            Sign in
          </Link>
        </p>
      </div>
    );
  }
  if (load.kind === "error") {
    return (
      <div role="alert" className="space-y-3">
        <p>{UNAVAILABLE}</p>
        <Button type="button" variant="outline" className="h-11" onClick={() => {
            setLoad({ kind: "loading" });
            setAttempt((n) => n + 1);
          }}>
          Try again
        </Button>
      </div>
    );
  }
  return <AcceptForm token={token} invitation={load.invitation} onInvalid={() => setLoad({ kind: "invalid", message: INVALID_INVITATION })} />;
}
