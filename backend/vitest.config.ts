// ===========================================================================
// Vitest configuration — the regression suite (Task T-A1).
//
// THE TEST DATABASE IS SET BEFORE ANYTHING ELSE. `.env.test` is loaded here, at
// the top of the config module and before the export, because the application's
// own `src/config/env.ts` begins with `import "dotenv/config"`, which loads
// `.env` (pointing at angaza_core). dotenv never overrides a variable that is
// already set, so loading the test values FIRST is what stops the app's `.env`
// from redirecting the suite at a real database. A variable already set in the
// shell (CI sets them in the workflow) wins over both files.
//
// The loaded values are also forwarded through `test.env`, so every worker
// process inherits exactly the environment global setup ran under.
// ===========================================================================

import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { defineConfig } from "vitest/config";

const loaded = loadDotenv({ path: path.resolve(__dirname, ".env.test"), quiet: true });

const forwarded: Record<string, string> = {};
for (const key of Object.keys(loaded.parsed ?? {})) {
  const value = process.env[key];
  if (value !== undefined) {
    forwarded[key] = value;
  }
}

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    env: forwarded,
    // The guard runs again in every worker before any test module is imported.
    setupFiles: ["test/setup/worker-guard.ts"],
    globalSetup: ["test/setup/global-setup.ts"],
    // SINGLE-THREADED. The integration suite shares one provisioned test tenant and
    // must run deterministically: one file at a time, in one worker process, so the
    // module-singleton pg pool (src/db/pool.ts) is created once and shared.
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    // Provisioning a tenant applies all 26 tenant migrations in one transaction.
    hookTimeout: 120_000,
    testTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/generated/**", "src/scripts/**", "src/**/*.test.ts"],
      reporter: ["text-summary", "lcov"],
    },
  },
});
