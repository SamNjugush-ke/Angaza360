import "server-only";

import type { NextRequest, NextResponse } from "next/server";
import { isApiErrorBody } from "@/lib/api/errors";
import { BffError, errorResponse } from "./http";

// The PUBLIC auth flows' BFF relay — password recovery, the business application and the
// invitation. Each route is a thin pass-through to ONE backend call: it checks the Origin, reads a
// JSON object, forwards the user's address (X-Forwarded-For) and returns the backend's answer.
// It sets NO cookie and starts NO session: none of these flows signs anybody in.

export const UNAVAILABLE = "The service is temporarily unavailable. Please try again shortly.";

/** The request body's string fields; a body that is not a JSON object, or a non-string field, is a 400. */
export async function readStringFields<K extends string>(
  request: NextRequest,
  required: readonly K[],
  optional: readonly K[] = [],
): Promise<Partial<Record<K, string>>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new BffError(400, "BadRequest", "Request body must be JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BffError(400, "BadRequest", "Request body must be an object.");
  }
  const record = body as Record<string, unknown>;
  const out: Partial<Record<K, string>> = {};
  for (const key of [...required, ...optional]) {
    const value = record[key];
    if (value === undefined || value === null) {
      if (required.includes(key)) throw new BffError(400, "BadRequest", `${key} is required.`);
      continue;
    }
    if (typeof value !== "string") throw new BffError(400, "BadRequest", `${key} must be a string.`);
    out[key] = value;
  }
  return out;
}

/**
 * The backend's refusal, passed through in the one error shape when the user can act on it
 * (`passThrough`); anything else — an unexpected status or an unreadable body — is a 502.
 */
export function relayRefusal(status: number, error: unknown, passThrough: readonly number[]): NextResponse {
  if (passThrough.includes(status) && isApiErrorBody(error)) {
    return errorResponse(status, error.error, error.message);
  }
  throw new BffError(502, "BadGateway", UNAVAILABLE);
}

/** The backend could not be reached at all. */
export function unreachable(): BffError {
  return new BffError(502, "BadGateway", UNAVAILABLE);
}
