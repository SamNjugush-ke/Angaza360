import { apiFetch } from "@/lib/api/browser";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { failureMessage, UNREACHABLE } from "./messages";

// JSON calls through the BFF proxy for the stock and procurement screens. apiFetch brings CSRF and
// the single-flight refresh; a refusal is thrown as an ApiHttpError carrying the backend's own
// message, which is written for people ("Insufficient stock for …") and shown as it is.

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await apiFetch(path, init);
  } catch {
    throw new ApiHttpError(0, UNREACHABLE);
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message = typeof body === "object" && body !== null && "message" in body && typeof body.message === "string" ? body.message : null;
    const code = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : null;
    throw new ApiHttpError(response.status, failureMessage(response.status, message), code);
  }
  return response;
}

export async function getJson<T>(path: string): Promise<T> {
  return (await (await call(path)).json()) as T;
}

export async function sendJson<T>(method: "POST" | "PUT" | "PATCH", path: string, body?: unknown, extraHeaders?: Readonly<Record<string, string>>): Promise<T> {
  const init: RequestInit = { method, headers: { "content-type": "application/json", ...extraHeaders } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return (await (await call(path, init)).json()) as T;
}

/** `path?a=1&b=2`, leaving out empty values. */
export function withParams(path: string, params: Readonly<Record<string, string | undefined>>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") query.set(key, value);
  const text = query.toString();
  return text === "" ? path : `${path}?${text}`;
}

/** A text response (a CSV template). */
export async function getText(path: string): Promise<string> {
  return (await call(path, { headers: { accept: "text/csv" } })).text();
}

/** A CSV request body (an upload), answered with JSON. */
export async function sendCsv<T>(path: string, csv: string): Promise<T> {
  return (await (await call(path, { method: "POST", headers: { "content-type": "text/csv" }, body: csv })).json()) as T;
}

/** A DELETE, answered with no content. */
export async function sendDelete(path: string): Promise<void> {
  await call(path, { method: "DELETE" });
}
