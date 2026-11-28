import { describe, expect, it } from "vitest";
import { resolveSeedPassword, SeedPasswordMissingError } from "../../src/scripts/seed-password";

// T-B-SEED-SECRET: the seed password comes from SEED_USER_PASSWORD only — no committed default — and
// the seed refuses to run without it.

describe("the seed password", () => {
  it("is read from SEED_USER_PASSWORD", () => {
    expect(resolveSeedPassword({ SEED_USER_PASSWORD: "a-local-secret-123" })).toBe("a-local-secret-123");
  });

  it("refuses when unset or blank, naming the variable and never a fallback", () => {
    for (const env of [{}, { SEED_USER_PASSWORD: "" }, { SEED_USER_PASSWORD: "   " }, { SEED_PASSWORD: "the-old-name" }]) {
      expect(() => resolveSeedPassword(env)).toThrow(SeedPasswordMissingError);
    }
    expect(() => resolveSeedPassword({})).toThrow(/SEED_USER_PASSWORD is not set/);
  });
});
