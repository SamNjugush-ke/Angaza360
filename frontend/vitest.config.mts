import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Run the suite in a zone far from Nairobi, so a helper that leaned on the host's own offset
// instead of Africa/Nairobi would produce the wrong business day and fail.
process.env.TZ = "America/Los_Angeles";

export default defineConfig({
  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL("./", import.meta.url)) },
      // "server-only" throws outside a React Server Components build; the suite runs server code
      // in plain Node, so it resolves to an empty module here (and only here).
      { find: /^server-only$/, replacement: fileURLToPath(new URL("./tests/support/empty.ts", import.meta.url)) },
    ],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // The till's tests drive whole sales through user-event, the real providers and axe; alone they
    // take 3–4s, and with every jsdom file running in parallel they can pass the 5s default. A longer
    // ceiling for a loaded machine, not a retry: a test that hangs still fails.
    testTimeout: 20_000,
  },
});
