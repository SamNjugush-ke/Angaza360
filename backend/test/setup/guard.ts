// ===========================================================================
// THE SAFETY GUARD (Task T-A1) — non-negotiable.
//
// The suite provisions and DROPS tenant schemas. Pointed at a real database that
// would be destructive, so every entry point that can touch the database calls
// this first: global setup (before any schema work), every worker (setupFiles),
// and every helper that drops anything. If the database named by DATABASE_URL
// does not match /test/i, the whole run aborts before a single statement runs.
// ===========================================================================

const TEST_DATABASE_PATTERN = /test/i;

/** The database name in a Postgres connection string. */
export function databaseNameOf(connectionString: string): string {
  const url = new URL(connectionString);
  return decodeURIComponent(url.pathname.replace(/^\//, ""));
}

/** Throws unless DATABASE_URL names a test database. Returns the database name. */
export function assertTestDatabase(): string {
  const raw = process.env["DATABASE_URL"];
  if (raw === undefined || raw === "") {
    throw new Error(
      "Refusing to run the test suite: DATABASE_URL is not set. Copy .env.test.example to .env.test.",
    );
  }
  const name = databaseNameOf(raw);
  if (!TEST_DATABASE_PATTERN.test(name)) {
    throw new Error(
      `Refusing to run the test suite against database "${name}": its name does not match ${TEST_DATABASE_PATTERN.toString()}. ` +
        "The suite provisions and drops schemas and must only ever touch a dedicated test database (angaza_test).",
    );
  }
  if (process.env["NODE_ENV"] !== "test") {
    throw new Error(
      `Refusing to run the test suite with NODE_ENV="${process.env["NODE_ENV"] ?? ""}": it must be "test".`,
    );
  }
  return name;
}
