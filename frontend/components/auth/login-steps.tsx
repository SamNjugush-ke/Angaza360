"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { FormAlert, messageOf, postJson, UNAVAILABLE } from "@/components/auth/form-bits";
import { AuthenticatorQr, BackupCodesPanel, CodeField, SetupKey } from "@/components/auth/mfa-bits";
import { PasswordField } from "@/components/auth/password-field";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password-strength";
import type { Role } from "@/lib/auth/landing";

// THE STAGED SIGN-IN (M4.5 Wave 1). After a correct password the account may still owe a step:
//   MFA_REQUIRED             — a code from the authenticator app, or a backup code;
//   PASSWORD_RESET_REQUIRED  — a new password (an issued one must be replaced before ANY access);
//   MFA_ENROLLMENT_REQUIRED  — an administrator without two-step verification sets it up now.
// The challenge itself lives in an HttpOnly cookie the BFF holds; these steps only send what the
// person types. A dead challenge sends them back to the password with the reason.

export type ChallengeStep = "MFA_REQUIRED" | "PASSWORD_RESET_REQUIRED" | "MFA_ENROLLMENT_REQUIRED";

type Answer =
  | { kind: "signed-in"; role: Role }
  | { kind: "next"; step: ChallengeStep }
  | { kind: "restart"; message: string }
  | { kind: "error"; message: string; status: number };

async function answerOf(response: Response | null): Promise<Answer & { backupCodes?: string[] }> {
  if (response === null) return { kind: "error", message: UNAVAILABLE, status: 0 };
  const body: unknown = await response.json().catch(() => null);
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (!response.ok) {
    const message = typeof record["message"] === "string" ? record["message"] : UNAVAILABLE;
    if (record["error"] === "ChallengeInvalid") return { kind: "restart", message };
    return { kind: "error", message, status: response.status };
  }
  const backupCodes = Array.isArray(record["backupCodes"]) ? record["backupCodes"].filter((c): c is string => typeof c === "string") : undefined;
  if (record["status"] === "AUTHENTICATED" && typeof record["role"] === "string") {
    return { kind: "signed-in", role: record["role"] as Role, ...(backupCodes ? { backupCodes } : {}) };
  }
  if (record["status"] === "MFA_REQUIRED" || record["status"] === "PASSWORD_RESET_REQUIRED" || record["status"] === "MFA_ENROLLMENT_REQUIRED") {
    return { kind: "next", step: record["status"], ...(backupCodes ? { backupCodes } : {}) };
  }
  return { kind: "error", message: UNAVAILABLE, status: response.status };
}

export interface LoginStepsProps {
  initial: ChallengeStep;
  onSignedIn: (role: Role) => void;
  onRestart: (message: string) => void;
}

export function LoginSteps({ initial, onSignedIn, onRestart }: LoginStepsProps) {
  const [step, setStep] = useState<ChallengeStep>(initial);
  const [pendingCodes, setPendingCodes] = useState<{ codes: string[]; then: Answer } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, [step, pendingCodes]);

  function follow(answer: Answer) {
    if (answer.kind === "signed-in") onSignedIn(answer.role);
    else if (answer.kind === "next") setStep(answer.step);
    else if (answer.kind === "restart") onRestart(answer.message);
  }

  if (pendingCodes !== null) {
    return (
      <div className="space-y-4">
        <h2 ref={headingRef} tabIndex={-1} className="sr-only">
          Two-step verification is on
        </h2>
        <BackupCodesPanel
          codes={pendingCodes.codes}
          continueLabel="Continue to Angaza360"
          onContinue={() => {
            const then = pendingCodes.then;
            setPendingCodes(null);
            follow(then);
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {step === "MFA_REQUIRED" ? <MfaStep headingRef={headingRef} follow={follow} /> : null}
      {step === "PASSWORD_RESET_REQUIRED" ? <NewPasswordStep headingRef={headingRef} follow={follow} /> : null}
      {step === "MFA_ENROLLMENT_REQUIRED" ? (
        <EnrollStep headingRef={headingRef} follow={follow} onCodes={(codes, then) => setPendingCodes({ codes, then })} />
      ) : null}
    </div>
  );
}

interface StepProps {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  follow: (answer: Answer) => void;
}

function MfaStep({ headingRef, follow }: StepProps) {
  const [backup, setBackup] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alertId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = code.trim();
    if (backup ? trimmed.replace(/[\s-]/g, "").length !== 10 : !/^\d{6}$/.test(trimmed)) {
      setError(backup ? "Enter one of your backup codes, like ABCDE-FGHJK." : "Enter the 6-digit code from your authenticator app.");
      return;
    }
    setBusy(true);
    setError(null);
    const answer = await answerOf(await postJson("/api/auth/login/mfa", { code: trimmed }));
    setBusy(false);
    if (answer.kind === "error") {
      setError(answer.status === 401 ? "That code didn’t work. Check your app and try the current code." : answer.message);
      setCode("");
      return;
    }
    follow(answer);
  }

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="space-y-4" aria-describedby={error ? alertId : undefined}>
      <div className="space-y-1">
        <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold focus:outline-none">
          Two-step verification
        </h2>
        <p className="text-sm text-muted-foreground">
          {backup ? "Enter one of the backup codes you saved. Each one works once." : "Open your authenticator app and enter the 6-digit code for Angaza360."}
        </p>
      </div>
      {error ? <FormAlert id={alertId}>{error}</FormAlert> : null}
      <CodeField
        label={backup ? "Backup code" : "Authentication code"}
        backup={backup}
        value={code}
        onChange={(event) => setCode(backup ? event.target.value.toUpperCase() : event.target.value.replace(/\D/g, ""))}
      />
      <Button type="submit" className="h-11 w-full" disabled={busy}>
        {busy ? "Checking…" : "Verify"}
      </Button>
      <button
        type="button"
        onClick={() => {
          setBackup((now) => !now);
          setCode("");
          setError(null);
        }}
        className="inline-flex min-h-11 items-center rounded-sm text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {backup ? "Use your authenticator app instead" : "Lost your phone? Use a backup code"}
      </button>
    </form>
  );
}

function NewPasswordStep({ headingRef, follow }: StepProps) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ password?: string; confirm?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const alertId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const next: typeof errors = {};
    if (password.length < MIN_PASSWORD_LENGTH) next.password = `Use at least ${MIN_PASSWORD_LENGTH.toString()} characters.`;
    if (confirm !== password) next.confirm = "The two passwords don’t match.";
    setErrors(next);
    if (next.password || next.confirm) return;
    setBusy(true);
    const answer = await answerOf(await postJson("/api/auth/login/password", { newPassword: password }));
    setBusy(false);
    if (answer.kind === "error") {
      setErrors(answer.status === 400 ? { password: answer.message } : { form: answer.message });
      return;
    }
    follow(answer);
  }

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="space-y-4" aria-describedby={errors.form ? alertId : undefined}>
      <div className="space-y-1">
        <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold focus:outline-none">
          Choose a new password
        </h2>
        <p className="text-sm text-muted-foreground">
          The password you signed in with was issued to you. Choose your own before you continue — it must be different from the
          one you were given.
        </p>
      </div>
      {errors.form ? <FormAlert id={alertId}>{errors.form}</FormAlert> : null}
      <PasswordField label="New password" value={password} error={errors.password} onChange={(event) => setPassword(event.target.value)} />
      <PasswordField
        label="Confirm new password"
        value={confirm}
        showStrength={false}
        error={errors.confirm}
        onChange={(event) => setConfirm(event.target.value)}
      />
      <Button type="submit" className="h-11 w-full" disabled={busy}>
        {busy ? "Saving…" : "Set password and continue"}
      </Button>
    </form>
  );
}

function EnrollStep({ headingRef, follow, onCodes }: StepProps & { onCodes: (codes: string[], then: Answer) => void }) {
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  const alertId = useId();

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      const response = await postJson("/api/auth/login/mfa-enrollment/start", {});
      if (response === null) {
        setLoadError(UNAVAILABLE);
        return;
      }
      if (!response.ok) {
        const body: unknown = await response.clone().json().catch(() => null);
        if (typeof body === "object" && body !== null && (body as { error?: unknown }).error === "ChallengeInvalid") {
          follow({ kind: "restart", message: (await messageOf(response)) ?? UNAVAILABLE });
          return;
        }
        setLoadError((await messageOf(response)) ?? UNAVAILABLE);
        return;
      }
      setSetup((await response.json()) as { secret: string; otpauthUri: string });
    })();
  }, [follow]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) {
      setError("Enter the 6-digit code your authenticator app shows.");
      return;
    }
    setBusy(true);
    setError(null);
    const answer = await answerOf(await postJson("/api/auth/login/mfa-enrollment/confirm", { code: code.trim() }));
    setBusy(false);
    if (answer.kind === "error") {
      setError(answer.status === 401 ? "That code didn’t match. Wait for the next code in your app and try again." : answer.message);
      setCode("");
      return;
    }
    if (answer.kind !== "restart" && answer.backupCodes && answer.backupCodes.length > 0) {
      const { backupCodes, ...then } = answer;
      onCodes(backupCodes, then);
      return;
    }
    follow(answer);
  }

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="space-y-4" aria-describedby={error ? alertId : undefined}>
      <div className="space-y-1">
        <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold focus:outline-none">
          Set up two-step verification
        </h2>
        <p className="text-sm text-muted-foreground">
          Your role manages businesses across the platform, so signing in needs a second step. Scan this code with an
          authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…), then enter the code it shows.
        </p>
      </div>
      {loadError ? <FormAlert id={alertId}>{loadError}</FormAlert> : null}
      {error ? <FormAlert id={alertId}>{error}</FormAlert> : null}
      {setup ? (
        <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
          <AuthenticatorQr uri={setup.otpauthUri} />
          <div className="space-y-1 text-sm">
            <p className="text-muted-foreground">Can’t scan? Type this setup key into the app:</p>
            <SetupKey secret={setup.secret} />
          </div>
        </div>
      ) : loadError ? null : (
        <p className="text-sm text-muted-foreground" role="status">
          Preparing your setup key…
        </p>
      )}
      <CodeField label="Code from your app" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} disabled={setup === null} />
      <Button type="submit" className="h-11 w-full" disabled={busy || setup === null}>
        {busy ? "Checking…" : "Turn on two-step verification"}
      </Button>
    </form>
  );
}
