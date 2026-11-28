// THE PHONE NORMALISER — the backend's one way to turn a typed phone number into canonical E.164.
// Every onboarding path that stores an owner's phone (the self-serve application, its edits, and
// batch CSV rows) calls it, so the same number is stored the same way whichever path it came by.
// The frontend carries an identical copy (frontend/lib/phone.ts) over the same library and the
// same test table; the two apps build and deploy separately and share no package.
//
// It is LENIENT about how a number is written and STRICT about what it is: spaces, dashes,
// parentheses and dots are ignored; "0729866328", "729866328", "254729866328" and "+254729866328"
// all become "+254729866328"; a number written with "+<code>" (or "00<code>") keeps that country.
// What comes out must be a valid number for its country (libphonenumber-js metadata), or it is
// refused — never guessed.

import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/min";

export type PhoneNormalisation =
  | { readonly ok: true; readonly e164: string }
  | { readonly ok: false; readonly reason: "MISSING" | "INVALID"; readonly message: string };

export const PHONE_DEFAULT_COUNTRY: CountryCode = "KE";
export const PHONE_MISSING_MESSAGE = "A phone number is required.";
export const PHONE_INVALID_MESSAGE = "Not a valid phone number.";

const SEPARATORS = /[\s\-().]/g;

export function normalizePhone(input: string | null | undefined, defaultCountry: CountryCode = PHONE_DEFAULT_COUNTRY): PhoneNormalisation {
  const compact = (input ?? "").replace(SEPARATORS, "");
  if (compact === "") return { ok: false, reason: "MISSING", message: PHONE_MISSING_MESSAGE };
  const written = compact.startsWith("00") ? `+${compact.slice(2)}` : compact;
  if (!/^\+?[0-9]+$/.test(written)) return { ok: false, reason: "INVALID", message: PHONE_INVALID_MESSAGE };
  const parsed = parsePhoneNumberFromString(written, defaultCountry);
  if (parsed === undefined || !parsed.isValid()) return { ok: false, reason: "INVALID", message: PHONE_INVALID_MESSAGE };
  return { ok: true, e164: parsed.number };
}
