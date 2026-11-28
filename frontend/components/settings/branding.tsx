"use client";

import { useId, useState, type FormEvent } from "react";
import { TextField } from "@/components/auth/form-bits";
import { ErrorState, LoadingState } from "@/components/states/states";
import { Done } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { HEX_COLOUR, saveBranding, useBranding, useInvalidateSettings, useProfile, type Branding, type Profile } from "@/lib/settings/settings";
import { Facts, ReadOnlyNote } from "./shared";

// Branding: the brand colour and the logo address, on the business's own registry row. The
// preview draws the receipt header exactly as the till's receipt does (components/pos/receipt-view)
// from the business profile and the values being typed, so the owner sees the result before saving.

function httpsProblem(typed: string): string | null {
  if (typed.trim() === "") return null;
  try {
    const url = new URL(typed.trim());
    return url.protocol === "https:" ? null : "The logo address must start with https://.";
  } catch {
    return "Enter the full address of the logo image, starting with https://.";
  }
}

/** The receipt's header block, as ReceiptSlip prints it. */
export function ReceiptHeaderPreview({ profile, businessName, colour, logoUrl }: { profile: Profile | undefined; businessName: string; colour: string | null; logoUrl: string | null }) {
  const accent = colour !== null && HEX_COLOUR.test(colour) ? colour : undefined;
  const name = profile?.legalName ?? businessName;
  const showLogo = logoUrl !== null && (profile?.showLogoOnReceipt ?? true);
  return (
    <figure className="space-y-2">
      <figcaption className="text-sm font-medium">How the top of a receipt will look</figcaption>
      <section aria-label="Receipt header preview" className="mx-auto w-full max-w-sm rounded-lg border bg-background p-4 font-mono text-xs leading-relaxed">
        <div className="space-y-0.5 border-b-2 pb-2 text-center" style={accent ? { borderColor: accent } : undefined} data-testid="preview-header">
          {showLogo ? (
            // A tenant-set https URL; next/image would need every tenant's host allow-listed.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="" width={96} height={48} className="mx-auto h-12 w-auto object-contain" />
          ) : null}
          <p className="font-sans text-sm font-semibold">{name}</p>
          {profile?.addressLine ? <p>{profile.addressLine}</p> : null}
          {profile?.phone ? <p>Tel {profile.phone}</p> : null}
          {profile?.email ? <p>{profile.email}</p> : null}
          {profile?.kraPin ? <p>KRA PIN {profile.kraPin}</p> : null}
        </div>
      </section>
      {logoUrl !== null && profile?.showLogoOnReceipt === false ? <p className="text-xs text-muted-foreground">The logo is set but switched off for receipts on the Business profile tab.</p> : null}
    </figure>
  );
}

function BrandingForm({ branding, profile, businessName }: { branding: Branding; profile: Profile | undefined; businessName: string }) {
  const ids = { colour: useId(), picker: useId(), logo: useId() };
  const invalidate = useInvalidateSettings();
  const [colour, setColour] = useState(branding.brandPrimaryColor ?? "");
  const [logo, setLogo] = useState(branding.brandLogoUrl ?? "");
  const [problems, setProblems] = useState<{ colour?: string; logo?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    const next: typeof problems = {};
    if (colour.trim() !== "" && !HEX_COLOUR.test(colour.trim())) next.colour = "A colour is # and six hex digits, e.g. #1F7A4D.";
    const logoProblem = httpsProblem(logo);
    if (logoProblem) next.logo = logoProblem;
    setProblems(next);
    if (Object.keys(next).length > 0) return;
    setSaving(true);
    setError(null);
    try {
      await saveBranding({ brandPrimaryColor: colour.trim() === "" ? null : colour.trim().toUpperCase(), brandLogoUrl: logo.trim() === "" ? null : logo.trim() });
      await invalidate();
      setNotice("Branding saved. Receipts use it from the next sale.");
    } catch (failure) {
      setError(failure instanceof ApiHttpError ? failure.message : "The branding could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const previewColour = colour.trim() === "" ? null : colour.trim();
  const previewLogo = logo.trim() !== "" && httpsProblem(logo) === null ? logo.trim() : null;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <form noValidate aria-label="Branding" onSubmit={(e) => void submit(e)} className="space-y-4">
        {notice ? <Done>{notice}</Done> : null}
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <TextField id={ids.colour} label="Brand colour" optional autoComplete="off" placeholder="#1F7A4D" value={colour} error={problems.colour} onChange={(e) => setColour(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor={ids.picker}>Pick</Label>
            <input id={ids.picker} type="color" className="block h-11 w-14 cursor-pointer rounded-md border" value={HEX_COLOUR.test(colour.trim()) ? colour.trim() : "#000000"} onChange={(e) => setColour(e.target.value.toUpperCase())} />
          </div>
        </div>
        <TextField id={ids.logo} label="Logo address" optional type="url" autoComplete="off" placeholder="https://…/logo.png" value={logo} error={problems.logo} hint="An https link to the logo image. Leave empty for no logo." onChange={(e) => setLogo(e.target.value)} />
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" className="h-11" disabled={saving}>
          {saving ? "Saving…" : "Save branding"}
        </Button>
      </form>
      <ReceiptHeaderPreview profile={profile} businessName={businessName} colour={previewColour} logoUrl={previewLogo} />
    </div>
  );
}

export function BrandingView({ owner, businessName }: { owner: boolean; businessName: string }) {
  const branding = useBranding();
  const profile = useProfile();
  if (branding.isPending) return <LoadingState label="Loading the branding" lines={3} />;
  if (branding.isError) return <ErrorState title="Couldn’t load the branding" description={branding.error.message} onRetry={() => void branding.refetch()} />;
  const b = branding.data;
  if (owner) return <BrandingForm branding={b} profile={profile.data} businessName={businessName} />;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-4">
        <ReadOnlyNote />
        <Facts
          label="Branding details"
          facts={[
            ["Brand colour", b.brandPrimaryColor],
            ["Logo address", b.brandLogoUrl],
          ]}
        />
      </div>
      <ReceiptHeaderPreview profile={profile.data} businessName={businessName} colour={b.brandPrimaryColor} logoUrl={b.brandLogoUrl} />
    </div>
  );
}
