// Runs in the worker before any test module is imported (vitest `setupFiles`).
// Global setup already refused a non-test database; this repeats the check where
// the tests actually connect, so a worker can never open the pool elsewhere.
import { assertTestDatabase } from "./guard";

assertTestDatabase();
