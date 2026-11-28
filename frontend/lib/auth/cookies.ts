import "server-only";

import { randomBytes } from "node:crypto";
import type { NextResponse } from "next/server";
import { CSRF_COOKIE } from "./csrf-shared";
import { LOCATION_COOKIE } from "@/lib/location/selection";
import { jwtExpiry } from "./jwt";
import { LEGACY_TENANT_NAME_COOKIE, SESSION_COOKIE } from "./names";

// The session lives in cookies the browser cannot read. The access and refresh tokens are set
// HttpOnly and NEVER appear in a response body, in JavaScript or in a readable cookie. Only the
// CSRF token (which must be readable, for the double-submit check) and the "remember me" flag
// are visible to scripts, and neither is a credential.

export { SESSION_COOKIE };
export const REFRESH_COOKIE = "ag_refresh";
// The business a SUPER_ADMIN is ACTING AS (god-mode, M4.5 W5): HttpOnly, holds {id,name}. The data
// proxy forwards its id as x-act-as-tenant; the server session reads it to adjust the shell and guard.
export const ACT_AS_COOKIE = "ag_act_as";
export { CSRF_COOKIE };
export const PERSIST_COOKIE = "ag_persist";

/** The refresh token is only ever sent to the one route that spends it. */
export const REFRESH_COOKIE_PATH = "/api/auth/refresh";

export const COOKIE_SECURE = process.env.NODE_ENV === "production";

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  /** ISO-8601 expiry of the refresh token. */
  expiresAt: string;
  /** Persistent cookies when true; browser-session cookies when false. */
  remember: boolean;
}

/** The access JWT's `exp` claim (unverified; see ./jwt) — sizes a persistent cookie. */
export { jwtExpiry };

function secondsUntil(epochSeconds: number): number {
  return Math.max(0, Math.floor(epochSeconds - Date.now() / 1000));
}

/** A fresh CSRF token: 32 random bytes, base64url. */
export function newCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Writes a new session onto the response, rotating the CSRF token. */
export function setSession(response: NextResponse, tokens: SessionTokens): void {
  const accessExp = tokens.remember ? jwtExpiry(tokens.accessToken) : null;
  const refreshExpMs = tokens.remember ? Date.parse(tokens.expiresAt) : Number.NaN;
  // Persistent cookies carry a max-age; a browser-session cookie carries none.
  const accessAge = accessExp === null ? {} : { maxAge: secondsUntil(accessExp) };
  const refreshAge = Number.isNaN(refreshExpMs) ? {} : { maxAge: secondsUntil(refreshExpMs / 1000) };

  response.cookies.set(SESSION_COOKIE, tokens.accessToken, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
    ...accessAge,
  });
  response.cookies.set(REFRESH_COOKIE, tokens.refreshToken, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "strict",
    path: REFRESH_COOKIE_PATH,
    ...refreshAge,
  });
  // The CSRF token and the remember flag live as long as the session can be refreshed.
  response.cookies.set(CSRF_COOKIE, newCsrfToken(), {
    httpOnly: false,
    secure: COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
    ...refreshAge,
  });
  // The business name now comes from /v1/auth/me (T-B-ME-NAME); drop any cookie that used to carry it.
  expire(response, LEGACY_TENANT_NAME_COOKIE, "/");
  if (tokens.remember) {
    response.cookies.set(PERSIST_COOKIE, "1", {
      httpOnly: false,
      secure: COOKIE_SECURE,
      sameSite: "lax",
      path: "/",
      ...refreshAge,
    });
  } else {
    expire(response, PERSIST_COOKIE, "/");
  }
}

function expire(response: NextResponse, name: string, path: string): void {
  response.cookies.set(name, "", {
    httpOnly: name === SESSION_COOKIE || name === REFRESH_COOKIE || name === LEGACY_TENANT_NAME_COOKIE,
    secure: COOKIE_SECURE,
    sameSite: name === REFRESH_COOKIE ? "strict" : "lax",
    path,
    maxAge: 0,
    expires: new Date(0),
  });
}

/** Expires every session cookie, each on the path it was set with. */
export function clearSession(response: NextResponse): void {
  expire(response, SESSION_COOKIE, "/");
  expire(response, REFRESH_COOKIE, REFRESH_COOKIE_PATH);
  expire(response, CSRF_COOKIE, "/");
  expire(response, PERSIST_COOKIE, "/");
  expire(response, LEGACY_TENANT_NAME_COOKIE, "/");
  // The working location is not a credential, but the next person on a shared device should
  // not inherit it.
  expire(response, LOCATION_COOKIE, "/");
  // An operator's act-as context never outlives their session.
  expire(response, ACT_AS_COOKIE, "/");
}
