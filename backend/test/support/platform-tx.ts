// ===========================================================================
// Raw SQL against the PLATFORM schema inside ONE transaction (Task T-A3 onward) —
// the platform-table counterpart of withTenantTx: the tool for ATTACKING a platform
// guarantee (a guard trigger, a CHECK) from outside the service layer.
//
// `rollback` (the default) always rolls back, so an adversarial write can never
// leave a trace even if the database wrongly accepts it.
// ===========================================================================

import type { PoolClient } from "pg";
import { pool } from "../../src/db/pool";
import { assertTestDatabase } from "../setup/guard";
import type { TxOutcome } from "../setup/tenant";

export async function withPlatformTx<T>(
  fn: (client: PoolClient) => Promise<T>,
  outcome: TxOutcome = "rollback",
): Promise<T> {
  assertTestDatabase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query(outcome === "commit" ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
