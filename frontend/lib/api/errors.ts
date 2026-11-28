import type { components } from "./schema";

// The backend has ONE error shape for the whole API (the engineering ledger, "API Documentation Is
// Schema-Driven"): { statusCode, error, message }. These helpers narrow openapi-fetch's
// { data, error, response } result to it.

/** The backend error envelope, as generated from the OpenAPI document. */
export type ApiErrorBody = components["schemas"]["Error"];

/** True when a value has the backend error envelope's shape. */
export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.statusCode === "number" &&
    typeof candidate.error === "string" &&
    typeof candidate.message === "string"
  );
}

/** A failed API call: the HTTP status and, when the body was the envelope, the envelope itself. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody | null;

  constructor(status: number, body: ApiErrorBody | null) {
    super(body ? `${body.error}: ${body.message}` : `API request failed with HTTP ${status}`);
    this.name = "ApiRequestError";
    this.status = status;
    this.body = body;
  }
}

/** The shape openapi-fetch resolves every call to. */
export interface ApiResult<Data, Err> {
  data?: Data;
  error?: Err;
  response: Response;
}

/** The envelope of a failed result, or null when the call succeeded or the body is not one. */
export function apiErrorOf<Data, Err>(result: ApiResult<Data, Err>): ApiErrorBody | null {
  if (result.error === undefined && result.response.ok) return null;
  return isApiErrorBody(result.error) ? result.error : null;
}

/** Returns the typed data of a successful call, or throws ApiRequestError carrying the envelope. */
export function unwrap<Data, Err>(result: ApiResult<Data, Err>): Data {
  if (result.error !== undefined || !result.response.ok) {
    throw new ApiRequestError(result.response.status, isApiErrorBody(result.error) ? result.error : null);
  }
  return result.data as Data;
}
