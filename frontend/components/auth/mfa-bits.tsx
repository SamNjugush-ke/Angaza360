"use client";

import { Check, Copy, Download } from "lucide-react";
import QRCode from "qrcode";
import { forwardRef, useEffect, useId, useState, type ComponentPropsWithoutRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PRODUCT_NAME } from "@/lib/brand";
import { cn } from "@/lib/utils";

// The two-step-verification pieces shared by the sign-in steps and the account security page
// (M4.5 Wave 1): the QR code for an authenticator app, the code field, and the backup codes.
// Nothing here stores a secret: the setup key and the backup codes live only in this component's
// state for as long as they are on screen.

/** The otpauth URI as a QR code — rendered to SVG, so it needs no canvas. */
export function AuthenticatorQr({ uri }: { uri: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" })
      .then((markup) => {
        if (live) setSvg(markup);
      })
      .catch(() => {
        if (live) setSvg(null);
      });
    return () => {
      live = false;
    };
  }, [uri]);
  return (
    <div className="flex size-48 items-center justify-center rounded-md border bg-white p-2">
      {svg === null ? (
        <span className="text-sm text-muted-foreground">Preparing the code…</span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- an inline data URI, not a fetched image
        <img
          src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`}
          alt={`QR code to add ${PRODUCT_NAME} to your authenticator app`}
          width={176}
          height={176}
          className="size-44"
        />
      )}
    </div>
  );
}

/** The setup key in groups of four, for typing into an app by hand. */
export function SetupKey({ secret }: { secret: string }) {
  const groups = secret.match(/.{1,4}/g) ?? [secret];
  return (
    <p className="break-all font-mono text-sm tracking-wider" aria-label={`Setup key: ${groups.join(" ")}`}>
      {groups.join(" ")}
    </p>
  );
}

export interface CodeFieldProps extends Omit<ComponentPropsWithoutRef<"input">, "type"> {
  label: string;
  error?: string;
  /** A backup code instead of a 6-digit authenticator code. */
  backup?: boolean;
}

export const CodeField = forwardRef<HTMLInputElement, CodeFieldProps>(function CodeField(
  { label, error, backup = false, id: givenId, className, ...input },
  ref,
) {
  const fallbackId = useId();
  const id = givenId ?? fallbackId;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        ref={ref}
        id={id}
        type="text"
        inputMode={backup ? "text" : "numeric"}
        autoComplete="one-time-code"
        autoCapitalize={backup ? "characters" : "off"}
        spellCheck={false}
        maxLength={backup ? 11 : 6}
        className={cn("h-11 font-mono text-lg tracking-widest", className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        {...input}
      />
      {error ? (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
});

/**
 * The ten one-time backup codes, shown ONCE: copy them, download them, and confirm they are
 * saved before going on.
 */
export function BackupCodesPanel({ codes, onContinue, continueLabel = "Continue" }: { codes: readonly string[]; onContinue: () => void; continueLabel?: string }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const confirmId = useId();
  const text = codes.join("\n");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function download() {
    const blob = new Blob([`${PRODUCT_NAME} backup codes — each works once.\n\n${text}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "angaza360-backup-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section aria-labelledby={`${confirmId}-title`} className="space-y-4">
      <div className="space-y-1">
        <h2 id={`${confirmId}-title`} className="text-lg font-semibold">
          Save your backup codes
        </h2>
        <p className="text-sm text-muted-foreground">
          If you lose your phone, each of these codes signs you in once. Keep them somewhere safe and private — this is the
          only time they are shown.
        </p>
      </div>
      <ol className="grid grid-cols-2 gap-2 rounded-md border bg-muted/40 p-3 font-mono text-sm" aria-label="Backup codes">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" className="h-11" onClick={() => void copy()}>
          {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          {copied ? "Copied" : "Copy codes"}
        </Button>
        <Button type="button" variant="outline" className="h-11" onClick={download}>
          <Download className="size-4" aria-hidden />
          Download
        </Button>
      </div>
      <label htmlFor={confirmId} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
        <input
          id={confirmId}
          type="checkbox"
          checked={saved}
          onChange={(event) => setSaved(event.target.checked)}
          className="size-5 rounded border-input accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        I have saved these codes
      </label>
      <Button type="button" className="h-11 w-full" disabled={!saved} onClick={onContinue}>
        {continueLabel}
      </Button>
    </section>
  );
}
