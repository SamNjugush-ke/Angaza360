import "server-only";

// Where the Next server reaches the Angaza360 backend. Read on the server only: API_BASE_URL is
// deliberately NOT a NEXT_PUBLIC_ variable, so it is never inlined into the browser bundle, and
// the "server-only" import makes any client-component import of this module a build error.

export const DEFAULT_API_BASE_URL = "http://localhost:4000";

export function apiBaseUrl(): string {
  return process.env.API_BASE_URL ?? DEFAULT_API_BASE_URL;
}
