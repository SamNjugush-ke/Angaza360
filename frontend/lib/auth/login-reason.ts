// Why the visitor is on the sign-in page, read from its ?reason= parameter. A plain module —
// no "use client" — because the SERVER page parses the parameter and the CLIENT notice
// renders it: a function exported from a "use client" file cannot be called on the server.

export type LoginReason = "expired" | "signed-out" | "reset" | "welcome";

export const LOGIN_REASONS: readonly LoginReason[] = ["expired", "signed-out", "reset", "welcome"];

/** The reason a ?reason= value names, or null for anything else. */
export function loginReasonOf(value: string | undefined): LoginReason | null {
  return (LOGIN_REASONS as readonly string[]).includes(value ?? "") ? (value as LoginReason) : null;
}
