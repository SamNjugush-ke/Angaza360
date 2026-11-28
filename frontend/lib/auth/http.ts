import "server-only";

import { NextResponse } from "next/server";
import type { ApiErrorBody } from "@/lib/api/errors";

// BFF responses in the backend's one error shape, { statusCode, error, message }, so the browser
// handles a BFF refusal exactly like a backend one.

export class BffError extends Error {
  readonly status: number;
  readonly error: string;

  constructor(status: number, error: string, message: string) {
    super(message);
    this.name = "BffError";
    this.status = status;
    this.error = error;
  }
}

export function errorResponse(status: number, error: string, message: string): NextResponse<ApiErrorBody> {
  return NextResponse.json({ statusCode: status, error, message }, { status });
}

/** Runs a route body, rendering a thrown BffError as its envelope. Anything else is a defect. */
export async function handle(run: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof BffError) return errorResponse(err.status, err.error, err.message);
    throw err;
  }
}
