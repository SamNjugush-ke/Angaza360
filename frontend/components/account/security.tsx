"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { FormAlert } from "@/components/auth/form-bits";
import { AuthenticatorQr, BackupCodesPanel, CodeField, SetupKey } from "@/components/auth/mfa-bits";
import { ErrorState, LoadingState } from "@/components/states/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getJson, sendJson } from "@/lib/api/request";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { formatDateTime } from "@/lib/datetime";

// YOUR SIGN-IN SECURITY (M4.5 Wave 1). The signed-in person's own two-step verification: set it
// up (anyone may opt in), replace the backup codes, and — for anyone whose role does not require
// it — turn it off with their password AND a code. For SUPER_ADMIN and PROGRAM_OFFICER it is
// required: they set it up at sign-in and cannot turn it off. The setup key and the backup codes
// are shown once, held only in this component, and never stored by the browser.

interface MfaStatus {
  enabled: boolean;
  required: boolean;
  enrolledAt: string | null;
  backupCodesRemaining: number;
}

const failure = (error: unknown, fallback: string) => (error instanceof ApiHttpError ? error.message : fallback);

const MFA_KEY = ["account", "mfa"] as const;

export function AccountSecurity() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: MFA_KEY, queryFn: () => getJson<MfaStatus>("/auth/mfa"), staleTime: 0 });
  const [codes, setCodes] = useState<string[] | null>(null);
  const status = query.data ?? null;
  const loadError = query.isError;
  const load = () => client.invalidateQueries({ queryKey: MFA_KEY });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-1">
        <h1 className="font-display text-2xl font-semibold">Sign-in security</h1>
        <p className="text-sm text-muted-foreground">Two-step verification adds a code from your phone to every sign-in.</p>
      </div>
      {codes !== null ? (
        <div className="rounded-lg border p-5">
          <BackupCodesPanel
            codes={codes}
            continueLabel="Done"
            onContinue={() => {
              setCodes(null);
              void load();
            }}
          />
        </div>
      ) : loadError ? (
        <ErrorState title="Your security settings couldn’t be loaded" onRetry={() => void load()} />
      ) : status === null ? (
        <LoadingState label="Loading your security settings" />
      ) : status.enabled ? (
        <Enabled status={status} onCodes={setCodes} onChanged={() => void load()} />
      ) : (
        <SetUp onCodes={setCodes} />
      )}
    </div>
  );
}

function SetUp({ onCodes }: { onCodes: (codes: string[]) => void }) {
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alertId = useId();

  async function start() {
    setBusy(true);
    setError(null);
    try {
      setSetup(await sendJson<{ secret: string; otpauthUri: string }>("POST", "/auth/mfa/setup"));
    } catch (problem) {
      setError(failure(problem, "Setup couldn’t start. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setError("Enter the 6-digit code your authenticator app shows.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { backupCodes } = await sendJson<{ backupCodes: string[] }>("POST", "/auth/mfa/confirm", { code });
      onCodes(backupCodes);
    } catch (problem) {
      setError(problem instanceof ApiHttpError && problem.status === 401 ? "That code didn’t match. Wait for the next code and try again." : failure(problem, "That didn’t work. Please try again."));
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4 rounded-lg border p-5" aria-labelledby={`${alertId}-title`}>
      <h2 id={`${alertId}-title`} className="text-lg font-semibold">
        Two-step verification is off
      </h2>
      {error ? <FormAlert id={alertId}>{error}</FormAlert> : null}
      {setup === null ? (
        <>
          <p className="text-sm text-muted-foreground">
            You will need an authenticator app on your phone. Setting it up signs you out of your other devices.
          </p>
          <Button type="button" className="h-11" disabled={busy} onClick={() => void start()}>
            {busy ? "Starting…" : "Set up two-step verification"}
          </Button>
        </>
      ) : (
        <form noValidate onSubmit={(event) => void confirm(event)} className="space-y-4">
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
            <AuthenticatorQr uri={setup.otpauthUri} />
            <div className="space-y-1 text-sm">
              <p className="text-muted-foreground">Scan the code with your app, or type this setup key:</p>
              <SetupKey secret={setup.secret} />
            </div>
          </div>
          <CodeField label="Code from your app" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} />
          <Button type="submit" className="h-11" disabled={busy}>
            {busy ? "Checking…" : "Turn on two-step verification"}
          </Button>
        </form>
      )}
    </section>
  );
}

function Enabled({ status, onCodes, onChanged }: { status: MfaStatus; onCodes: (codes: string[]) => void; onChanged: () => void }) {
  return (
    <div className="space-y-4">
      <section className="space-y-1 rounded-lg border p-5">
        <h2 className="text-lg font-semibold">Two-step verification is on</h2>
        <p className="text-sm text-muted-foreground">
          {status.enrolledAt ? `Set up ${formatDateTime(status.enrolledAt)}. ` : ""}
          {status.backupCodesRemaining} unused backup {status.backupCodesRemaining === 1 ? "code" : "codes"} left.
        </p>
        {status.required ? (
          <p className="text-sm text-muted-foreground">Your role requires it, so it can’t be turned off. If you lose your phone and your backup codes, another administrator can reset it for you.</p>
        ) : null}
      </section>
      <ReplaceCodes onCodes={onCodes} />
      {status.required ? null : <TurnOff onChanged={onChanged} />}
    </div>
  );
}

function ReplaceCodes({ onCodes }: { onCodes: (codes: string[]) => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alertId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setError("Enter the current 6-digit code from your app.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { backupCodes } = await sendJson<{ backupCodes: string[] }>("POST", "/auth/mfa/backup-codes", { code });
      onCodes(backupCodes);
    } catch (problem) {
      setError(problem instanceof ApiHttpError && problem.status === 401 ? "That code didn’t work. Try the current code." : failure(problem, "That didn’t work. Please try again."));
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="space-y-4 rounded-lg border p-5" aria-labelledby={`${alertId}-title`}>
      <div className="space-y-1">
        <h2 id={`${alertId}-title`} className="text-lg font-semibold">
          Replace your backup codes
        </h2>
        <p className="text-sm text-muted-foreground">You get ten new codes and the old ones stop working.</p>
      </div>
      {error ? <FormAlert id={alertId}>{error}</FormAlert> : null}
      <CodeField label="Code from your app" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} />
      <Button type="submit" variant="outline" className="h-11" disabled={busy}>
        {busy ? "Replacing…" : "Get new backup codes"}
      </Button>
    </form>
  );
}

function TurnOff({ onChanged }: { onChanged: () => void }) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = { alert: useId(), password: useId() };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password.length === 0 || code.trim().length < 6) {
      setError("Enter your password and a current code.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetchNoContent("/auth/mfa/disable", { currentPassword: password, code: code.trim() });
      if (response) onChanged();
    } catch (problem) {
      setError(problem instanceof ApiHttpError && problem.status === 401 ? "The password or the code is wrong." : failure(problem, "That didn’t work. Please try again."));
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="space-y-4 rounded-lg border p-5" aria-labelledby={`${ids.alert}-title`}>
      <div className="space-y-1">
        <h2 id={`${ids.alert}-title`} className="text-lg font-semibold">
          Turn off two-step verification
        </h2>
        <p className="text-sm text-muted-foreground">Your sign-in goes back to a password only. Your backup codes stop working.</p>
      </div>
      {error ? <FormAlert id={ids.alert}>{error}</FormAlert> : null}
      <div className="space-y-2">
        <Label htmlFor={ids.password}>Current password</Label>
        <Input id={ids.password} type="password" autoComplete="current-password" className="h-11" value={password} onChange={(event) => setPassword(event.target.value)} />
      </div>
      <CodeField label="Code from your app or a backup code" backup value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} />
      <Button type="submit" variant="outline" className="h-11" disabled={busy}>
        {busy ? "Turning off…" : "Turn off"}
      </Button>
    </form>
  );
}

/** A POST answered 204, through the same BFF door as every data call. */
async function fetchNoContent(path: string, body: unknown): Promise<boolean> {
  const { apiFetch } = await import("@/lib/api/browser");
  let response: Response;
  try {
    response = await apiFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new ApiHttpError(0, "Couldn’t reach the server. Check the connection and try again.");
  }
  if (response.status === 204) return true;
  const payload: unknown = await response.json().catch(() => null);
  const message =
    typeof payload === "object" && payload !== null && "message" in payload && typeof payload.message === "string" ? payload.message : "The request could not be completed.";
  throw new ApiHttpError(response.status, message);
}
