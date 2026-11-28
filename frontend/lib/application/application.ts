// The business application's fields, steps and early checks (M4.5 Wave 2). The checks mirror the
// backend's green-gate (services/tenants/candidate.ts) so a typo is caught before the round trip;
// the backend is the authority. No value here is computed or trusted — it is only checked.

import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/min";
import { normalizePhone } from "@/lib/phone";

export const APPLICATION_FIELDS = [
  "businessName",
  "businessStructure",
  "registrationNumber",
  "businessKraPin",
  "sector",
  "description",
  "permitNumber",
  "physicalAddress",
  "county",
  "businessPhone",
  "businessEmail",
  "taxRegime",
  "requestedTier",
  "ownerFullName",
  "ownerEmail",
  "ownerPhone",
  "ownerNationalId",
  "kraPin",
] as const;

export type ApplicationField = (typeof APPLICATION_FIELDS)[number] | "docFRONT" | "docBACK";
export type ApplicationValues = Record<(typeof APPLICATION_FIELDS)[number], string>;
export type FieldErrors = Partial<Record<ApplicationField, string>>;

export const EMPTY_APPLICATION: ApplicationValues = Object.fromEntries(APPLICATION_FIELDS.map((field) => [field, ""])) as ApplicationValues;

export const STEPS = ["The business", "Where it operates", "Tax and plan", "The owner", "ID document", "Review and submit"] as const;

/** Which fields each step holds — a server error is shown on its step. */
export const STEP_FIELDS: ReadonlyArray<readonly ApplicationField[]> = [
  ["businessName", "businessStructure", "registrationNumber", "businessKraPin", "sector", "description", "permitNumber"],
  ["physicalAddress", "county", "businessPhone", "businessEmail"],
  ["taxRegime", "requestedTier"],
  ["ownerFullName", "ownerEmail", "ownerPhone", "ownerNationalId", "kraPin"],
  ["docFRONT", "docBACK"],
  [],
];

export const STRUCTURE_OPTIONS = [
  { value: "SOLE_PROPRIETOR", label: "Sole proprietor", hint: "One owner trading in their own name or a business name." },
  { value: "PARTNERSHIP", label: "Partnership", hint: "Two or more partners, registered as a partnership." },
  { value: "LIMITED_COMPANY", label: "Limited company", hint: "Incorporated, with a company registration number." },
] as const;

export const REGIME_OPTIONS = [
  { value: "TURNOVER_TAX", label: "Turnover Tax (most small businesses)" },
  { value: "VAT_REGISTERED", label: "VAT registered" },
  { value: "EXEMPT", label: "Exempt" },
] as const;

export const TIER_OPTIONS = ["MWANZO", "UKUAJI", "BIASHARA", "MSTAWI", "ENTERPRISE"] as const;

/** What each plan is called on screen; the value sent stays the platform's tier name. */
export const TIER_LABELS: Readonly<Record<(typeof TIER_OPTIONS)[number], string>> = {
  MWANZO: "Starter",
  UKUAJI: "Growth",
  BIASHARA: "Business",
  MSTAWI: "Scale",
  ENTERPRISE: "Enterprise",
};

/** A tier's display name, or the value itself if it is not one we know. */
export function tierLabel(tier: string): string {
  return (TIER_LABELS as Readonly<Record<string, string>>)[tier] ?? tier;
}

/** Countries offered beside the owner's phone, by ISO code (the normaliser's default country).
 * Kenya is the default; a number typed with its own "+" keeps that country, so any code works. */
export const PHONE_COUNTRIES = [
  { iso: "KE", label: "Kenya (+254)" },
  { iso: "UG", label: "Uganda (+256)" },
  { iso: "TZ", label: "Tanzania (+255)" },
  { iso: "RW", label: "Rwanda (+250)" },
  { iso: "BI", label: "Burundi (+257)" },
  { iso: "SS", label: "South Sudan (+211)" },
  { iso: "ET", label: "Ethiopia (+251)" },
  { iso: "SO", label: "Somalia (+252)" },
  { iso: "CD", label: "DR Congo (+243)" },
  { iso: "NG", label: "Nigeria (+234)" },
  { iso: "ZA", label: "South Africa (+27)" },
  { iso: "AE", label: "United Arab Emirates (+971)" },
  { iso: "IN", label: "India (+91)" },
  { iso: "GB", label: "United Kingdom (+44)" },
  { iso: "US", label: "United States / Canada (+1)" },
] as const satisfies ReadonlyArray<{ iso: CountryCode; label: string }>;

export type PhoneCountry = (typeof PHONE_COUNTRIES)[number]["iso"];
export const DEFAULT_PHONE_COUNTRY: PhoneCountry = "KE";

/** The owner's phone as it will be sent: canonical E.164 when it reads as a valid number for the
 * chosen country (or the country its "+" names), otherwise exactly as typed, for the check to name. */
export function ownerPhoneForSubmit(country: PhoneCountry, typed: string): string {
  const result = normalizePhone(typed, country);
  return result.ok ? result.e164 : typed.trim();
}

/** The offered country a canonical number belongs to (for the selector), or Kenya. */
export function phoneCountryOf(e164: string): PhoneCountry {
  const country = parsePhoneNumberFromString(e164)?.country;
  return PHONE_COUNTRIES.find((c) => c.iso === country)?.iso ?? DEFAULT_PHONE_COUNTRY;
}

const KRA_PIN = /^[AP][0-9]{9}[A-Z]$/;
const PHONE = /^\+?[0-9]{9,15}$/;
const NATIONAL_ID = /^[0-9]{6,10}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const clean = (value: string) => value.trim();
const compact = (value: string) => value.replace(/[\s-]/g, "");

/** The early checks for ONE step. */
export function checkStep(step: number, v: ApplicationValues, nationalIdOnFile = false): FieldErrors {
  const e: FieldErrors = {};
  if (step === 0) {
    if (clean(v.businessName).length < 2) e.businessName = "Enter the business name (2–200 characters).";
    if (v.businessStructure === "") e.businessStructure = "Choose how the business is set up.";
    if (v.businessStructure === "LIMITED_COMPANY" && clean(v.registrationNumber) === "") e.registrationNumber = "A company’s registration number is required.";
    if ((v.businessStructure === "PARTNERSHIP" || v.businessStructure === "LIMITED_COMPANY") && clean(v.businessKraPin) === "") e.businessKraPin = "Enter the business’s own KRA PIN.";
    if (clean(v.businessKraPin) !== "" && !KRA_PIN.test(clean(v.businessKraPin).toUpperCase())) e.businessKraPin = "A KRA PIN is a letter, nine digits and a letter, e.g. P051234567X.";
  }
  if (step === 1) {
    if (clean(v.physicalAddress) === "") e.physicalAddress = "Say where the business operates.";
    if (v.county === "") e.county = "Choose the county.";
    if (clean(v.businessPhone) !== "" && !PHONE.test(compact(v.businessPhone))) e.businessPhone = "A phone number is 9–15 digits, optionally with a leading +.";
    if (clean(v.businessEmail) !== "" && !EMAIL.test(clean(v.businessEmail))) e.businessEmail = "Enter a valid email address.";
  }
  if (step === 2 && v.taxRegime === "") e.taxRegime = "Choose how the business is taxed.";
  if (step === 3) {
    if (clean(v.ownerFullName) === "") e.ownerFullName = "Enter the owner’s full name.";
    if (!EMAIL.test(clean(v.ownerEmail))) e.ownerEmail = "Enter a valid email address.";
    // ownerPhone arrives here already normalised (ownerPhoneForSubmit); the backend applies the same rule.
    const phone = normalizePhone(v.ownerPhone);
    if (!phone.ok) e.ownerPhone = phone.reason === "MISSING" ? "Enter the owner’s phone number." : "Enter a valid phone number, e.g. 0712 345 678 for Kenya.";
    if (!(nationalIdOnFile && clean(v.ownerNationalId) === "") && !NATIONAL_ID.test(v.ownerNationalId.replace(/\s/g, ""))) e.ownerNationalId = "A National ID number is 6–10 digits.";
    if (clean(v.kraPin) !== "" && !KRA_PIN.test(clean(v.kraPin).toUpperCase())) e.kraPin = "A KRA PIN is a letter, nine digits and a letter, e.g. P051234567X.";
  }
  return e;
}

/** What the backend receives: trimmed strings, blanks as null; a sole proprietor sends no business PIN. */
export function payloadOf(v: ApplicationValues): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const field of APPLICATION_FIELDS) {
    const value = clean(v[field]);
    out[field] = value === "" ? null : value;
  }
  if (v.businessStructure === "SOLE_PROPRIETOR") out["businessKraPin"] = null;
  // A resumed application shows the ID masked; a blank field keeps the number on file.
  if (out["ownerNationalId"] === null) delete out["ownerNationalId"];
  if (out["taxRegime"] === null) out["taxRegime"] = "";
  out["businessName"] = out["businessName"] ?? "";
  out["ownerFullName"] = out["ownerFullName"] ?? "";
  out["ownerEmail"] = out["ownerEmail"] ?? "";
  return out;
}
