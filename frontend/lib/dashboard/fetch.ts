import { apiFetch } from "@/lib/api/browser";
import { failureMessage, UNREACHABLE } from "@/lib/api/messages";

// How a dashboard panel reads the API: through the BFF proxy with the browser client (CSRF and
// the single-flight refresh on 401 come with it). The answer is one of three things:
//   * the data, typed from schema.d.ts, money still a STRING of cents;
//   * NOT_PERMITTED — the backend answered 403 for this role, so the panel HIDES (it is not an
//     error: a cashier simply has no payables);
//   * ABSENT — only where a hook opts in: the resource does not exist for this business (eTIMS
//     never initialised answers 404), so the panel hides too;
// and anything else — a 5xx, a network failure, an unexpected 4xx — is thrown as an ApiHttpError
// so THAT panel shows its error state and the rest of the dashboard carries on.

export const NOT_PERMITTED = { kind: "not-permitted" } as const;
export type NotPermitted = typeof NOT_PERMITTED;

export const ABSENT = { kind: "absent" } as const;
export type Absent = typeof ABSENT;

/** A panel's data, or the reason it is hidden. */
export type Gated<T> = T | NotPermitted;

export function isNotPermitted(value: unknown): value is NotPermitted {
  return value === NOT_PERMITTED;
}

export function isAbsent(value: unknown): value is Absent {
  return value === ABSENT;
}

export class ApiHttpError extends Error {
  /** The HTTP status; 0 when the request never got an answer (network). */
  readonly status: number;
  /** The backend's error name (`StepUpRequired`, `Conflict`, …) when it sent one. */
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "ApiHttpError";
    this.status = status;
    this.code = code;
  }
}

type QueryValue = string | number | undefined;

/** A path under /api/v1 with its query string; undefined values are left out. */
export function withQuery(path: string, query: Record<string, QueryValue> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const search = params.toString();
  return search === "" ? path : `${path}?${search}`;
}

async function send(path: string): Promise<Response> {
  try {
    return await apiFetch(path);
  } catch {
    // fetch rejected: offline or the BFF unreachable.
    throw new ApiHttpError(0, UNREACHABLE);
  }
}

async function failure(response: Response): Promise<ApiHttpError> {
  const body: unknown = await response.json().catch(() => null);
  const message = typeof body === "object" && body !== null && "message" in body && typeof body.message === "string" ? body.message : null;
  return new ApiHttpError(response.status, failureMessage(response.status, message));
}

/** GET a source; 403 resolves to NOT_PERMITTED. */
export async function getGated<T>(path: string): Promise<Gated<T>> {
  const response = await send(path);
  if (response.status === 403) return NOT_PERMITTED;
  if (!response.ok) throw await failure(response);
  return (await response.json()) as T;
}

/** GET a source that may not exist for this business; 403 -> NOT_PERMITTED, 404 -> ABSENT. */
export async function getOptional<T>(path: string): Promise<Gated<T> | Absent> {
  const response = await send(path);
  if (response.status === 403) return NOT_PERMITTED;
  if (response.status === 404) return ABSENT;
  if (!response.ok) throw await failure(response);
  return (await response.json()) as T;
}
