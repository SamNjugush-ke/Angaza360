// ===========================================================================
// Asserting WHICH database guarantee refused a write (Task T-A1).
//
// A test that only checks "it threw" is not binding: the write could have failed for
// an unrelated reason (a typo, a missing column) and the guarantee could be gone. So
// every adversarial test pins the refusal to the NAMED artifact — the plpgsql function
// in the error's `where` context, or the constraint name — and, where useful, the
// SQLSTATE.
// ===========================================================================

import { DatabaseError } from "pg";
import { expect } from "vitest";

export interface ExpectedRefusal {
  /** The plpgsql function that raised, as it appears in the error context. */
  fn?: string;
  /** The violated constraint's name (CHECK / UNIQUE / FK). */
  constraint?: string;
  /** Five-character SQLSTATE. */
  code?: string;
  message?: RegExp;
}

/** Await a promise that MUST be refused by Postgres, and assert who refused it. */
export async function expectDbRefusal(
  promise: Promise<unknown>,
  expected: ExpectedRefusal,
): Promise<DatabaseError> {
  let caught: unknown = undefined;
  let resolved = false;
  try {
    await promise;
    resolved = true;
  } catch (error) {
    caught = error;
  }
  if (resolved) {
    throw new Error(
      `Expected the database to refuse this write (${JSON.stringify({ ...expected, message: expected.message?.source })}), but it was ACCEPTED.`,
    );
  }
  if (!(caught instanceof DatabaseError)) {
    throw new Error(`Expected a Postgres DatabaseError, got: ${String(caught)}`);
  }
  if (expected.fn !== undefined) {
    // Postgres reports the function schema-qualified: "PL/pgSQL function <schema>.<fn>() line N at RAISE".
    expect(caught.where ?? "", `error context should name ${expected.fn}()`).toMatch(
      new RegExp(`function (?:[a-z0-9_]+\\.)?${expected.fn}\\(\\)`),
    );
  }
  if (expected.constraint !== undefined) {
    expect(caught.constraint).toBe(expected.constraint);
  }
  if (expected.code !== undefined) {
    expect(caught.code).toBe(expected.code);
  }
  if (expected.message !== undefined) {
    expect(caught.message).toMatch(expected.message);
  }
  return caught;
}

/**
 * The SQLSTATE carried anywhere in an error raised through Prisma's driver adapter.
 * Prisma wraps the pg error; the original code survives on a nested field whose path
 * differs by error kind, so search the error's own properties (and its `cause` chain)
 * for a 5-character SQLSTATE under a key that names one.
 */
export function sqlStateOf(error: unknown): string | null {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): string | null => {
    if (value === null || typeof value !== "object" || seen.has(value) || depth > 6) {
      return null;
    }
    seen.add(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      const child: unknown = Reflect.get(value, key);
      if (
        (key === "code" || key === "originalCode" || key === "sqlState") &&
        typeof child === "string" &&
        /^[0-9A-Z]{5}$/.test(child) &&
        !/^P[1-9]\d{3}$/.test(child) // Prisma's own P1xxx/P2xxx codes are not SQLSTATEs
      ) {
        return child;
      }
      const nested = visit(child, depth + 1);
      if (nested !== null) {
        return nested;
      }
    }
    return null;
  };
  return visit(error, 0);
}
