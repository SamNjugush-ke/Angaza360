"use client";

import { CheckCircle2, Info } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { FormAlert, TextField, UNAVAILABLE } from "@/components/auth/form-bits";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  APPLICATION_FIELDS,
  DEFAULT_PHONE_COUNTRY,
  EMPTY_APPLICATION,
  PHONE_COUNTRIES,
  ownerPhoneForSubmit,
  phoneCountryOf,
  type PhoneCountry,
  STEP_FIELDS,
  STEPS,
  STRUCTURE_OPTIONS,
  TIER_LABELS,
  TIER_OPTIONS,
  REGIME_OPTIONS,
  checkStep,
  payloadOf,
  tierLabel,
  type ApplicationField,
  type ApplicationValues,
  type FieldErrors,
} from "@/lib/application/application";


const SELECT_CLASS =
  "flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:text-sm";

function Why({ children }: { children: ReactNode }) {
  return (
    <p className="flex gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>
        <span className="font-medium text-foreground">Why we ask: </span>
        {children}
      </span>
    </p>
  );
}

function Select({ id, label, value, error, onChange, children, hint }: { id: string; label: string; value: string; error?: string; onChange: (value: string) => void; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <select id={id} className={SELECT_CLASS} value={value} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
      {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface Options {
  counties: string[];
  maxDocumentBytes: number;
}

type Uploaded = Partial<Record<"FRONT" | "BACK", string>>;

async function readBody(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json().catch(() => null);
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}

/** The backend's field errors ({ errors: [{ field, message }] }) as a map, plus the rest. */
function serverErrors(body: Record<string, unknown>): { fields: FieldErrors; general: string | null } {
  const fields: FieldErrors = {};
  const list = Array.isArray(body["errors"]) ? (body["errors"] as Array<{ field?: unknown; message?: unknown }>) : [];
  for (const item of list) {
    if (typeof item.field === "string" && typeof item.message === "string") {
      const field = (item.field === "subdomain" ? "businessName" : item.field) as ApplicationField;
      if ((APPLICATION_FIELDS as readonly string[]).includes(field)) fields[field] = item.message;
    }
  }
  const general = Object.keys(fields).length === 0 && typeof body["message"] === "string" ? (body["message"] as string) : null;
  return { fields, general };
}

export function ApplicationForm({ resume = false }: { resume?: boolean }) {
  const router = useRouter();
  const base = useId();
  const idOf = (field: string) => `${base}-${field}`;
  const [step, setStep] = useState(0);
  const [values, setValues] = useState<ApplicationValues>(EMPTY_APPLICATION);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [uploaded, setUploaded] = useState<Uploaded>({});
  const [agreed, setAgreed] = useState(false);
  const [options, setOptions] = useState<Options | null>(null);
  const [phoneCountry, setPhoneCountry] = useState<PhoneCountry>(DEFAULT_PHONE_COUNTRY);
  const heading = useRef<HTMLHeadingElement>(null);
  const fileInputs = useRef<Partial<Record<"FRONT" | "BACK", HTMLInputElement | null>>>({});
  // What is checked, saved and reviewed: the owner's phone joined with its country code (E.164).
  const composed: ApplicationValues = { ...values, ownerPhone: ownerPhoneForSubmit(phoneCountry, values.ownerPhone) };

  useEffect(() => {
    void (async () => {
      const response = await fetch("/api/application/options", { credentials: "same-origin" }).catch(() => null);
      if (response?.ok) setOptions((await response.json()) as Options);
    })();
  }, []);

  useEffect(() => {
    if (!resume) return;
    void (async () => {
      const response = await fetch("/api/application", { credentials: "same-origin" }).catch(() => null);
      if (!response?.ok) {
        setFormError("We couldn’t open your application in this browser. Use the link in our latest email.");
        return;
      }
      const status = (await response.json()) as { application: Record<string, string | null>; documents: Array<{ side: "FRONT" | "BACK"; deleted: boolean }> };
      const next = { ...EMPTY_APPLICATION };
      for (const field of APPLICATION_FIELDS) {
        const value = status.application[field];
        if (typeof value === "string") next[field] = value;
      }
      if (next.ownerPhone !== "") setPhoneCountry(phoneCountryOf(next.ownerPhone));
      setValues(next);
      setSaved(true);
      const docs: Uploaded = {};
      for (const doc of status.documents) if (!doc.deleted) docs[doc.side] = "already uploaded";
      setUploaded(docs);
    })();
  }, [resume]);

  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  const set = (field: keyof ApplicationValues) => (value: string) => setValues((now) => ({ ...now, [field]: value }));
  const text = (field: keyof ApplicationValues, label: string, extra: Partial<Parameters<typeof TextField>[0]> = {}) => (
    <TextField id={idOf(field)} label={label} value={values[field]} error={errors[field]} onChange={(e) => set(field)(e.target.value)} {...extra} />
  );

  function goTo(target: number) {
    setFormError(null);
    setStep(target);
  }

  /** Saves the draft (create on first save, then edit). False when the server refused. */
  async function save(): Promise<boolean> {
    const response = await fetch("/api/application", {
      method: saved ? "PATCH" : "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payloadOf(composed)),
    }).catch(() => null);
    if (response === null) {
      setFormError(UNAVAILABLE);
      return false;
    }
    if (response.ok) {
      setSaved(true);
      return true;
    }
    const { fields, general } = serverErrors(await readBody(response));
    setErrors(fields);
    setFormError(general ?? (Object.keys(fields).length > 0 ? "Some details need attention." : UNAVAILABLE));
    const first = STEP_FIELDS.findIndex((stepFields) => stepFields.some((f) => fields[f] !== undefined));
    if (first >= 0) setStep(first);
    return false;
  }

  async function next() {
    const problems = checkStep(step, composed, resume);
    setErrors(problems);
    if (Object.keys(problems).length > 0) {
      setFormError("Some details need attention.");
      return;
    }
    setFormError(null);
    // The draft is first saved once the owner's details are in; after that, every step saves.
    if (step >= 3 || saved) {
      setBusy(true);
      const ok = await save();
      setBusy(false);
      if (!ok) return;
    }
    goTo(step + 1);
  }

  /** Forgets this side's chosen file and any message about it; another file must then be uploaded. */
  function clearSide(side: "FRONT" | "BACK") {
    const input = fileInputs.current[side];
    if (input) input.value = "";
    setUploaded((now) => {
      const rest = { ...now };
      delete rest[side];
      return rest;
    });
    setErrors((now) => ({ ...now, [`doc${side}`]: undefined }));
  }

  async function upload(side: "FRONT" | "BACK", file: File | undefined) {
    if (!file) return;
    // A new file replaces whatever was said about the last one.
    setErrors((now) => ({ ...now, [`doc${side}`]: undefined }));
    const max = options?.maxDocumentBytes ?? 5 * 1024 * 1024;
    if (!["image/jpeg", "image/png", "application/pdf"].includes(file.type)) {
      setErrors((now) => ({ ...now, [`doc${side}`]: "Choose a JPG, PNG or PDF file." }));
      return;
    }
    if (file.size > max) {
      setErrors((now) => ({ ...now, [`doc${side}`]: "The file is larger than 5 MB. Choose a smaller photo or scan." }));
      return;
    }
    setBusy(true);
    const response = await fetch(`/api/application/documents/${side}`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": file.type },
      body: file,
    }).catch(() => null);
    setBusy(false);
    if (response?.ok) {
      setUploaded((now) => ({ ...now, [side]: file.name }));
      setErrors((now) => ({ ...now, [`doc${side}`]: undefined }));
      return;
    }
    const body = response ? await readBody(response) : {};
    setErrors((now) => ({ ...now, [`doc${side}`]: typeof body["message"] === "string" ? (body["message"] as string) : UNAVAILABLE }));
  }

  async function submit() {
    if (!agreed) {
      setFormError("Confirm the details and accept the Terms and Privacy Policy to submit.");
      return;
    }
    setBusy(true);
    const response = await fetch("/api/application/submit", { method: "POST", credentials: "same-origin" }).catch(() => null);
    setBusy(false);
    if (response?.status === 202) {
      router.push("/application/status");
      return;
    }
    const { fields, general } = response ? serverErrors(await readBody(response)) : { fields: {}, general: UNAVAILABLE };
    setErrors(fields);
    setFormError(general ?? "Some details need attention before the application can be submitted.");
    const first = STEP_FIELDS.findIndex((stepFields) => stepFields.some((f) => fields[f] !== undefined));
    if (first >= 0 && fields.ownerNationalId === undefined) setStep(first);
    else if (fields.ownerNationalId !== undefined && (!uploaded.FRONT || !uploaded.BACK)) setStep(4);
  }

  const structure = values.businessStructure;
  const needsBusinessPin = structure === "PARTNERSHIP" || structure === "LIMITED_COMPANY";

  return (
    <div className="space-y-5">
      <nav aria-label="Application steps">
        <ol className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
          {STEPS.map((title, index) => (
            <li key={title} aria-current={index === step ? "step" : undefined} className={index === step ? "font-semibold text-foreground" : "text-muted-foreground"}>
              {index + 1}. {title}
            </li>
          ))}
        </ol>
      </nav>
      <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold focus:outline-none">
        Step {step + 1} of {STEPS.length}: {STEPS[step]}
      </h2>
      {formError ? <FormAlert id={idOf("alert")}>{formError}</FormAlert> : null}

      {step === 0 ? (
        <div className="space-y-4">
          {text("businessName", "Business name", { autoComplete: "organization" })}
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">How is the business set up?</legend>
            {STRUCTURE_OPTIONS.map((option) => (
              <label key={option.value} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border p-3 text-sm">
                <input type="radio" name={idOf("structure")} value={option.value} checked={structure === option.value} onChange={() => set("businessStructure")(option.value)} className="mt-0.5 size-4 accent-primary" />
                <span>
                  <span className="font-medium">{option.label}</span>
                  <span className="block text-muted-foreground">{option.hint}</span>
                </span>
              </label>
            ))}
            {errors.businessStructure ? <p className="text-sm text-destructive">{errors.businessStructure}</p> : null}
          </fieldset>
          {structure === "LIMITED_COMPANY" || structure === "PARTNERSHIP"
            ? text("registrationNumber", structure === "LIMITED_COMPANY" ? "Company registration number" : "Business registration number", { optional: structure === "PARTNERSHIP", hint: "As on the certificate, e.g. PVT-ABC123 or BN-XYZ789." })
            : null}
          {needsBusinessPin ? text("businessKraPin", "The business’s KRA PIN", { hint: "A partnership or company has its own PIN, separate from the owner’s." }) : null}
          {needsBusinessPin ? <Why>to meet the business’s tax obligations — including KRA eTIMS invoices issued under its own PIN.</Why> : null}
          {text("sector", "What the business does", { optional: true, hint: "e.g. Hardware, Agro-vet, Salon." })}
          {text("description", "A short description", { optional: true })}
          {text("permitNumber", "County business permit number", { optional: true })}
        </div>
      ) : null}

      {step === 1 ? (
        <div className="space-y-4">
          {text("physicalAddress", "Where the business operates", { autoComplete: "street-address", hint: "Street, building or market, and town." })}
          <Select id={idOf("county")} label="County" value={values.county} error={errors.county} onChange={set("county")}>
            <option value="">Choose a county</option>
            {(options?.counties ?? []).map((county) => (
              <option key={county} value={county}>
                {county}
              </option>
            ))}
          </Select>
          <Why>to confirm the business is real and operating in Kenya, and so programme support can be organised by county.</Why>
          {text("businessPhone", "Business phone", { optional: true, autoComplete: "tel", inputMode: "tel" })}
          {text("businessEmail", "Business email", { optional: true, autoComplete: "email", inputMode: "email" })}
        </div>
      ) : null}

      {step === 2 ? (
        <div className="space-y-4">
          <Select id={idOf("taxRegime")} label="How is the business taxed?" value={values.taxRegime} error={errors.taxRegime} onChange={set("taxRegime")} hint="This decides how sales are taxed in the books. You can change it later in settings.">
            <option value="">Choose one</option>
            {REGIME_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <Select id={idOf("requestedTier")} label="Plan" value={values.requestedTier} error={errors.requestedTier} onChange={set("requestedTier")} hint="Optional — the team will confirm the plan with you.">
            <option value="">Not sure yet</option>
            {TIER_OPTIONS.map((tier) => (
              <option key={tier} value={tier}>
                {TIER_LABELS[tier]}
              </option>
            ))}
          </Select>
        </div>
      ) : null}

      {step === 3 ? (
        <div className="space-y-4">
          {text("ownerFullName", "Owner’s full legal name", { autoComplete: "name", hint: "As on the National ID." })}
          {text("ownerEmail", "Owner’s email", { autoComplete: "email", inputMode: "email", hint: "We send every update about the application here." })}
          <div className="space-y-2">
            <Label htmlFor={idOf("ownerPhone")}>Owner’s phone</Label>
            <div className="flex gap-2">
              <select
                aria-label="Country code"
                className={`${SELECT_CLASS} w-auto max-w-[11rem] shrink-0`}
                value={phoneCountry}
                onChange={(e) => setPhoneCountry(e.target.value as PhoneCountry)}
              >
                {PHONE_COUNTRIES.map((country) => (
                  <option key={country.iso} value={country.iso}>
                    {country.label}
                  </option>
                ))}
              </select>
              <input
                id={idOf("ownerPhone")}
                type="tel"
                autoComplete="tel-national"
                inputMode="tel"
                required
                placeholder="712 345 678"
                value={values.ownerPhone}
                aria-invalid={errors.ownerPhone ? true : undefined}
                aria-describedby={`${idOf("ownerPhone")}-hint${errors.ownerPhone ? ` ${idOf("ownerPhone")}-error` : ""}`}
                onChange={(e) => set("ownerPhone")(e.target.value)}
                onBlur={() => {
                  // Show the number as it will be stored, and follow the country its "+" names.
                  const canonical = ownerPhoneForSubmit(phoneCountry, values.ownerPhone);
                  if (!canonical.startsWith("+")) return;
                  if (canonical !== values.ownerPhone) set("ownerPhone")(canonical);
                  setPhoneCountry(phoneCountryOf(canonical));
                }}
                className="flex h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:text-sm"
              />
            </div>
            <p id={`${idOf("ownerPhone")}-hint`} className="text-sm text-muted-foreground">
              A leading 0 is fine. For another country, choose its code or type the full number starting with +.
            </p>
            {errors.ownerPhone ? (
              <p id={`${idOf("ownerPhone")}-error`} className="text-sm text-destructive">
                {errors.ownerPhone}
              </p>
            ) : null}
          </div>
          {text("ownerNationalId", "Owner’s National ID number", { inputMode: "numeric" })}
          <Why>to verify the owner’s identity and prevent fraud. It is checked against the ID document you upload next, and never shown in full again after you submit.</Why>
          {text("kraPin", needsBusinessPin ? "Owner’s personal KRA PIN" : "Owner’s KRA PIN", { optional: true, hint: needsBusinessPin ? undefined : "For a sole proprietor this is also the business’s PIN." })}
          <Why>for the business’s tax records and KRA eTIMS. Optional now; it can be added later in settings.</Why>
        </div>
      ) : null}

      {step === 4 ? (
        <div className="space-y-4">
          <Why>
            to confirm the owner is who they say they are (Kenya Data Protection Act, s.29–30). The scans are encrypted, never shown to anyone except the
            reviewer handling your application, every look is recorded, and they are deleted on a fixed schedule after the decision — see the{" "}
            <Link href="/privacy" className="font-medium text-primary underline-offset-4 hover:underline">
              Privacy Policy
            </Link>
            .
          </Why>
          {(["FRONT", "BACK"] as const).map((side) => {
            const id = idOf(`doc${side}`);
            const error = errors[`doc${side}` as ApplicationField];
            return (
              <div key={side} className="space-y-2 rounded-md border p-3">
                <Label htmlFor={id}>{side === "FRONT" ? "Front of the National ID" : "Back of the National ID"}</Label>
                <input
                  id={id}
                  ref={(element) => {
                    fileInputs.current[side] = element;
                  }}
                  type="file"
                  accept="image/jpeg,image/png,application/pdf"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? `${id}-error` : `${id}-hint`}
                  className="block w-full text-sm file:mr-3 file:min-h-11 file:rounded-md file:border-0 file:bg-secondary file:px-4 file:font-medium"
                  onChange={(e) => void upload(side, e.target.files?.[0])}
                />
                <p id={`${id}-hint`} className="text-sm text-muted-foreground">
                  JPG, PNG or PDF, up to 5 MB. A clear photo of the whole card works.
                </p>
                {uploaded[side] ? (
                  <p className="flex items-center gap-2 text-sm text-emerald-800 dark:text-emerald-300" role="status">
                    <CheckCircle2 className="size-4" aria-hidden /> Uploaded{uploaded[side] === "already uploaded" ? "" : `: ${uploaded[side] ?? ""}`}
                  </p>
                ) : null}
                {uploaded[side] || error ? (
                  <Button type="button" variant="outline" size="sm" className="h-9" disabled={busy} onClick={() => clearSide(side)}>
                    Clear {side === "FRONT" ? "front" : "back"}
                  </Button>
                ) : null}
                {error ? (
                  <p id={`${id}-error`} className="text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {step === 5 ? (
        <div className="space-y-4">
          <dl className="divide-y rounded-md border text-sm">
            {APPLICATION_FIELDS.filter((field) => composed[field].trim() !== "").map((field) => (
              <div key={field} className="flex justify-between gap-4 px-3 py-2">
                <dt className="text-muted-foreground">{FIELD_LABEL[field]}</dt>
                <dd className="break-all text-right">
                  {field === "ownerNationalId" ? `•••${composed[field].slice(-3)}` : field === "requestedTier" ? tierLabel(composed[field]) : composed[field]}
                </dd>
              </div>
            ))}
            <div className="flex justify-between gap-4 px-3 py-2">
              <dt className="text-muted-foreground">ID document</dt>
              <dd>{uploaded.FRONT && uploaded.BACK ? "Front and back uploaded" : "Missing — go back to step 5"}</dd>
            </div>
          </dl>
          <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 size-5 accent-primary" />
            <span>
              I confirm these details are correct and I agree to the{" "}
              <Link href="/terms" className="font-medium text-primary underline-offset-4 hover:underline">
                Terms of Service
              </Link>{" "}
              and the{" "}
              <Link href="/privacy" className="font-medium text-primary underline-offset-4 hover:underline">
                Privacy Policy
              </Link>
              .
            </span>
          </label>
        </div>
      ) : null}

      <div className="flex flex-wrap justify-between gap-2">
        {step > 0 ? (
          <Button type="button" variant="outline" className="h-11" disabled={busy} onClick={() => goTo(step - 1)}>
            Back
          </Button>
        ) : (
          <span />
        )}
        {step < STEPS.length - 1 ? (
          <Button
            type="button"
            className="h-11"
            disabled={busy || (step === 4 && (!uploaded.FRONT || !uploaded.BACK))}
            onClick={() => void next()}
          >
            {busy ? "Saving…" : "Continue"}
          </Button>
        ) : (
          <Button type="button" className="h-11" disabled={busy} onClick={() => void submit()}>
            {busy ? "Submitting…" : "Submit the application"}
          </Button>
        )}
      </div>
      {saved ? <p className="text-sm text-muted-foreground">Your progress is saved in this browser.</p> : null}
    </div>
  );
}

const FIELD_LABEL: Readonly<Record<keyof ApplicationValues, string>> = {
  businessName: "Business name",
  businessStructure: "Structure",
  registrationNumber: "Registration number",
  businessKraPin: "Business KRA PIN",
  sector: "What it does",
  description: "Description",
  permitNumber: "Permit number",
  physicalAddress: "Address",
  county: "County",
  businessPhone: "Business phone",
  businessEmail: "Business email",
  taxRegime: "Tax regime",
  requestedTier: "Plan",
  ownerFullName: "Owner",
  ownerEmail: "Owner’s email",
  ownerPhone: "Owner’s phone",
  ownerNationalId: "Owner’s National ID",
  kraPin: "Owner’s KRA PIN",
};
