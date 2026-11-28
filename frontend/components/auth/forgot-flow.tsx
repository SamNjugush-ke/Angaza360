"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password-strength";
import { FormAlert, messageOf, postJson, TextField, UNAVAILABLE } from "./form-bits";
import { PasswordField } from "./password-field";

// Password recovery in two steps, both through the BFF (which sets no cookie):
//   1. the email — answered the SAME way whether or not an account exists, so the page says
//      only "if an account exists, a code has been sent" and never which;
//   2. the code from that message and a new password — on success the account is signed out
//      everywhere and the user signs in again, so we go to /login with a notice.

const emailSchema = z.object({
  email: z.string().trim().min(1, "Enter your email address.").pipe(z.email("Enter a valid email address.")),
});

const resetSchema = z
  .object({
    token: z.string().trim().min(1, "Enter the reset code from the message we sent."),
    newPassword: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH.toString()} characters.`),
    confirmPassword: z.string().min(1, "Type the new password again."),
  })
  .refine((values) => values.newPassword === values.confirmPassword, {
    path: ["confirmPassword"],
    message: "The two passwords do not match.",
  });

type EmailValues = z.infer<typeof emailSchema>;
type ResetValues = z.infer<typeof resetSchema>;

export const SENT_NOTICE = "If an account exists for that email, a reset code has been sent.";

function RequestStep({ onSent }: { onSent: (email: string) => void }) {
  const ids = { email: useId(), form: useId() };
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<EmailValues>({ resolver: zodResolver(emailSchema), defaultValues: { email: "" } });

  async function onSubmit({ email }: EmailValues) {
    setFormError(null);
    const response = await postJson("/api/auth/password/forgot", { email });
    if (response === null) return setFormError(UNAVAILABLE);
    if (response.status === 202) return onSent(email);
    // A throttle carries a message meant for the user; nothing else says anything about the email.
    setFormError(response.status === 429 ? ((await messageOf(response)) ?? UNAVAILABLE) : UNAVAILABLE);
  }

  return (
    <form noValidate onSubmit={handleSubmit(onSubmit)} aria-describedby={formError ? ids.form : undefined} className="space-y-5">
      {formError ? <FormAlert id={ids.form}>{formError}</FormAlert> : null}
      <TextField
        id={ids.email}
        label="Email address"
        type="email"
        autoComplete="email"
        inputMode="email"
        error={errors.email?.message}
        {...register("email")}
      />
      <Button type="submit" className="h-11 w-full" disabled={isSubmitting}>
        {isSubmitting ? "Sending…" : "Send reset code"}
      </Button>
    </form>
  );
}

function ResetStep({ email, onRestart }: { email: string; onRestart: () => void }) {
  const router = useRouter();
  const ids = { token: useId(), password: useId(), confirm: useId(), form: useId(), notice: useId() };
  const [formError, setFormError] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);
  const notice = useRef<HTMLParagraphElement>(null);
  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
  } = useForm<ResetValues>({
    resolver: zodResolver(resetSchema),
    defaultValues: { token: "", newPassword: "", confirmPassword: "" },
  });

  // Move focus to the confirmation, so a screen-reader user hears where the code went.
  useEffect(() => notice.current?.focus(), []);

  async function onSubmit({ token, newPassword }: ResetValues) {
    setFormError(null);
    const response = await postJson("/api/auth/password/reset", { token: token.trim(), newPassword });
    if (response === null) return setFormError(UNAVAILABLE);
    if (response.status === 204) {
      setNavigating(true);
      router.push("/login?reason=reset");
      return;
    }
    // An unknown, used or expired code — or a refused password — comes back as the backend's own message.
    setFormError(response.status === 400 || response.status === 429 ? ((await messageOf(response)) ?? UNAVAILABLE) : UNAVAILABLE);
  }

  const [newPassword, confirmPassword] = useWatch({ control, name: ["newPassword", "confirmPassword"] });
  const busy = isSubmitting || navigating;

  return (
    <div className="space-y-5">
      <p
        id={ids.notice}
        ref={notice}
        tabIndex={-1}
        role="status"
        className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {SENT_NOTICE} Check <span className="font-medium">{email}</span> (and your phone, if your account has one). The code
        can be used once and expires soon.
      </p>
      <form noValidate onSubmit={handleSubmit(onSubmit)} aria-describedby={formError ? ids.form : undefined} className="space-y-5">
        {formError ? <FormAlert id={ids.form}>{formError}</FormAlert> : null}
        <TextField
          id={ids.token}
          label="Reset code"
          autoComplete="one-time-code"
          autoCapitalize="none"
          spellCheck={false}
          error={errors.token?.message}
          {...register("token")}
        />
        <PasswordField id={ids.password} label="New password" value={newPassword} error={errors.newPassword?.message} {...register("newPassword")} />
        <PasswordField
          id={ids.confirm}
          label="Confirm new password"
          value={confirmPassword}
          showStrength={false}
          error={errors.confirmPassword?.message}
          {...register("confirmPassword")}
        />
        <Button type="submit" className="h-11 w-full" disabled={busy}>
          {busy ? "Resetting…" : "Reset password"}
        </Button>
      </form>
      <Button type="button" variant="link" className="h-11 px-0" onClick={onRestart}>
        Use a different email or send a new code
      </Button>
    </div>
  );
}

export function ForgotFlow() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  return sentTo === null ? <RequestStep onSent={setSentTo} /> : <ResetStep email={sentTo} onRestart={() => setSentTo(null)} />;
}
