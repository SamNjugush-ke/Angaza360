import { Pool } from "pg";
import { env } from "../config/env";

// EVERY SESSION RUNS IN UTC (Task H.1). The server's own default is the host's zone
// (Africa/Nairobi on this deployment), and without this pin `CURRENT_TIMESTAMP` /
// `now()` in a column default, a raw-SQL write or a trigger would record Nairobi
// wall-clock time while the application reads instants as UTC — a silent three-hour
// skew on any row not written through Prisma. Pinned at connection start, so it holds
// for Prisma, raw SQL, the migration runner and every script alike. Business-day
// cutting is a separate concern and lives in src/lib/business-time.ts.
export const pool = new Pool({
  connectionString: env.databaseUrl,
  options: "-c timezone=UTC",
  max: 10,
  idleTimeoutMillis: 30000,
});

export async function closePool(): Promise<void> {
  await pool.end();
}
