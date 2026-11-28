// The seed password for the development / test accounts (Task T-B-SEED-SECRET).
//
// It comes from SEED_USER_PASSWORD and NOTHING ELSE: there is no committed fallback, because a
// default in the repository is a password every reader of the repository knows. Unset or empty, the
// seed refuses to run. The value is never logged.

export class SeedPasswordMissingError extends Error {
  constructor() {
    super("SEED_USER_PASSWORD is not set. Set it in backend/.env (never commit it) to the password the seeded accounts should use, then run the seed again.");
    this.name = "SeedPasswordMissingError";
  }
}

export function resolveSeedPassword(env: Readonly<Record<string, string | undefined>>): string {
  const value = env["SEED_USER_PASSWORD"];
  if (value === undefined || value.trim() === "") throw new SeedPasswordMissingError();
  return value;
}
