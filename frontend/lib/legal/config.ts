// The OPERATOR'S own details the legal pages need (M4.5 Wave 2). They are facts about the legal
// entity running Angaza360 — who it is, where it is registered, its Data Protection Officer, its
// ODPC registration — and they are NEVER written into the code or invented: each comes from a
// NEXT_PUBLIC_LEGAL_* variable, and an unset one renders as a visible "[to be completed]" marker.

export const LEGAL_TOKENS = [
  "LEGAL_ENTITY",
  "REGISTERED_ADDRESS",
  "DPO_NAME",
  "DPO_EMAIL",
  "SUPPORT_EMAIL",
  "ODPC_REG_NO",
  "EFFECTIVE_DATE",
  "GOVERNING_COUNTY",
] as const;

export type LegalToken = (typeof LEGAL_TOKENS)[number];

const clean = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

// Each read is spelled out (not process.env[name]) so Next inlines it into the static pages.
export const LEGAL_VALUES: Readonly<Record<LegalToken, string | null>> = {
  LEGAL_ENTITY: clean(process.env.NEXT_PUBLIC_LEGAL_ENTITY),
  REGISTERED_ADDRESS: clean(process.env.NEXT_PUBLIC_LEGAL_REGISTERED_ADDRESS),
  DPO_NAME: clean(process.env.NEXT_PUBLIC_LEGAL_DPO_NAME),
  DPO_EMAIL: clean(process.env.NEXT_PUBLIC_LEGAL_DPO_EMAIL),
  // The public support address; NEXT_PUBLIC_CONTACT_EMAIL (the landing's older variable) is honoured as a fallback.
  SUPPORT_EMAIL: clean(process.env.NEXT_PUBLIC_LEGAL_SUPPORT_EMAIL) ?? clean(process.env.NEXT_PUBLIC_CONTACT_EMAIL),
  ODPC_REG_NO: clean(process.env.NEXT_PUBLIC_LEGAL_ODPC_REG_NO),
  EFFECTIVE_DATE: clean(process.env.NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE),
  GOVERNING_COUNTY: clean(process.env.NEXT_PUBLIC_LEGAL_GOVERNING_COUNTY),
};

export function isLegalToken(value: string): value is LegalToken {
  return (LEGAL_TOKENS as readonly string[]).includes(value);
}

export const TO_BE_COMPLETED = "[to be completed]";

/** The pages, in footer order. */
export const LEGAL_PAGES = [
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/terms", label: "Terms of Service" },
  { href: "/cookies", label: "Cookie Policy" },
  { href: "/acceptable-use", label: "Acceptable Use Policy" },
  { href: "/contact", label: "Contact" },
] as const;
