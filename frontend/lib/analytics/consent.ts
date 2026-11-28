// The visitor's analytics consent: a readable first-party cookie, "granted" or "denied". Absent
// means NOT granted — nothing that tracks may run until the visitor says yes. The cookie banner
// (components/consent/cookie-consent.tsx, M4.5 W2 — T-B3's banner) writes it through
// setAnalyticsConsent, which also RECORDS the choice: what was chosen, under which version of the
// cookie policy, and when (CONSENT_RECORD_COOKIE). Essential cookies (the session, CSRF and the
// working location) are not subject to consent — they are what makes the service work.

export const CONSENT_COOKIE = "ag_analytics_consent";
export type AnalyticsConsent = "granted" | "denied";

export function readAnalyticsConsent(cookieHeader: string): AnalyticsConsent | null {
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== CONSENT_COOKIE) continue;
    const value = rest.join("=");
    return value === "granted" || value === "denied" ? value : null;
  }
  return null;
}

/** Bumped when the cookie policy changes what it asks for: an older record asks again. */
export const CONSENT_VERSION = "1";
export const CONSENT_RECORD_COOKIE = "ag_consent_record";
/** Fired on window when the choice changes, so the analytics slot re-reads it at once. */
export const CONSENT_CHANGED_EVENT = "angaza:consent-changed";
/** Fired on window to reopen the banner (the footer's "Cookie settings"). */
export const CONSENT_OPEN_EVENT = "angaza:consent-open";

const YEAR = 60 * 60 * 24 * 365;

export function setAnalyticsConsent(value: AnalyticsConsent, now: Date = new Date()): void {
  document.cookie = `${CONSENT_COOKIE}=${value}; Path=/; Max-Age=${YEAR.toString()}; SameSite=Lax`;
  document.cookie = `${CONSENT_RECORD_COOKIE}=${encodeURIComponent(`${CONSENT_VERSION}|${value}|${now.toISOString()}`)}; Path=/; Max-Age=${YEAR.toString()}; SameSite=Lax`;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CONSENT_CHANGED_EVENT));
}

export interface ConsentRecord {
  readonly version: string;
  readonly value: AnalyticsConsent;
  readonly at: string;
}

export function readConsentRecord(cookieHeader: string): ConsentRecord | null {
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== CONSENT_RECORD_COOKIE) continue;
    const [version, value, at] = decodeURIComponent(rest.join("=")).split("|");
    if (version && (value === "granted" || value === "denied") && at) return { version, value, at };
  }
  return null;
}

/** The banner asks until there is a choice recorded under the CURRENT policy version. */
export function consentNeeded(cookieHeader: string): boolean {
  const record = readConsentRecord(cookieHeader);
  return record === null || record.version !== CONSENT_VERSION || readAnalyticsConsent(cookieHeader) === null;
}

/** Analytics may load only when a measurement id is configured AND consent was granted. */
export function analyticsEnabled(measurementId: string | undefined, consent: AnalyticsConsent | null): measurementId is string {
  return Boolean(measurementId) && consent === "granted";
}
