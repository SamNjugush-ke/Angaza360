// What a person is told when a request fails (M4.5 W3 feedback pass). Never a bare status code
// or a server's technical words: the backend's own message is shown when it is written for people
// (a 4xx — "Insufficient stock for …", "This shift belongs to another cashier"); otherwise a plain
// sentence that says what to do next — and, for a server fault, that the change may or may not
// have gone through, so the person checks before repeating something that moves money or stock.

// A bare HTTP status phrase (Fastify's defaults) or an "HTTP 500" — not words for a person.
const TECHNICAL = /^(internal server error|bad gateway|service unavailable|gateway timeout|not found|forbidden|unauthorized|bad request|conflict|too many requests|unsupported media type|payload too large|request failed.*|http \d+.*|error)\.?$/i;

export const SERVER_FAULT =
  "Something went wrong on our side. It may or may not have been saved — refresh and check before trying again. If it keeps happening, contact support.";
export const UNREACHABLE = "Couldn’t reach the server. Check your connection and try again — nothing was sent.";

/** The message to show for an HTTP failure. */
export function failureMessage(status: number, serverMessage: string | null): string {
  if (status === 0) return UNREACHABLE;
  if (status >= 500) return SERVER_FAULT;
  const message = serverMessage?.trim() ?? "";
  if (message !== "" && !TECHNICAL.test(message)) return message;
  if (status === 401) return "Your session has ended. Sign in again to carry on.";
  if (status === 403) return "Your role does not allow this. Ask the business owner if you need it.";
  if (status === 404) return "That could not be found — it may have been removed. Refresh and try again.";
  if (status === 409) return "This was changed by someone else in the meantime. Refresh to see the latest, then try again.";
  if (status === 429) return "Too many attempts in a short time. Wait a minute, then try again.";
  return "The request could not be completed. Check the details and try again.";
}
