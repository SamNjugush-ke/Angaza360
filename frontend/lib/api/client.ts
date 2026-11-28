import "server-only";

import createClient, { type Client } from "openapi-fetch";
import { apiBaseUrl } from "./config";
import type { paths } from "./schema";

// The typed Angaza360 API client, for SERVER-SIDE use only — route handlers of the Next BFF and
// server components. The browser never calls the backend directly: it talks to the Next BFF
// under /api/*, which forwards with the session (auth/cookie wiring and same-origin browser
// access arrive in F0.2-D).
//
// Every path, parameter and response is typed from lib/api/schema.d.ts, generated from the
// backend's own OpenAPI document (lib/api/openapi.json). Money arrives as a STRING of cents and
// stays one — hand it to lib/money.ts, never to Number().
//
// Refreshing after an API change: start the backend (`cd backend && npm run dev`), then from
// frontend/:
//   curl -fsS http://localhost:4000/docs/json -o lib/api/openapi.json
//   npm run gen:api
// and commit both files. gen:api needs no running backend.

export type ApiClient = Client<paths>;

export interface ApiClientOptions {
  /** Defaults to API_BASE_URL (server env), else http://localhost:4000. */
  baseUrl?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

export function createApiClient(opts: ApiClientOptions = {}): ApiClient {
  return createClient<paths>({
    baseUrl: opts.baseUrl ?? apiBaseUrl(),
    fetch: opts.fetch,
    headers: opts.headers,
  });
}
