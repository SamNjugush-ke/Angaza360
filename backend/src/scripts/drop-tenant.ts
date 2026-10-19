// CLI entry point for DESTROYING a tenant: drops its Postgres schema (CASCADE)
// and deletes its public.tenants registry row, in one transaction.
//
// DEVELOPMENT CONVENIENCE ONLY. This is a destructive, irreversible operation
// intended for resetting local/dev state. It hard-refuses to run when
// NODE_ENV === "production", and hard-refuses without the literal --force flag.
//
// Usage:
//   npm run tenant:drop -- --subdomain nakuru-hardware --force

import { closePool, pool } from "../db/pool";
import { disconnectAllTenantDbs } from "../db/tenant";
import { assertValidSchemaName, tenantSchemaName } from "../db/tenant";

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(key, "");
    } else {
      flags.set(key, next);
      i += 1;
    }
  }
  return flags;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to drop a tenant: NODE_ENV is 'production'. This command is a development convenience only.",
    );
  }

  const flags = parseFlags(process.argv.slice(2));

  if (!flags.has("force")) {
    throw new Error(
      "Refusing to drop a tenant without the literal --force flag. This is a destructive, irreversible operation.",
    );
  }

  const subdomain = flags.get("subdomain");
  if (subdomain === undefined || subdomain === "") {
    throw new Error("Missing required flag --subdomain");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const found = await client.query<{ dbSchema: string }>(
      `SELECT "dbSchema" FROM public.tenants WHERE "subdomain" = $1`,
      [subdomain],
    );

    const registryRow = found.rows[0];
    const schema = registryRow?.dbSchema ?? tenantSchemaName(subdomain);
    assertValidSchemaName(schema);

    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    const deleted = await client.query(
      `DELETE FROM public.tenants WHERE "subdomain" = $1`,
      [subdomain],
    );

    await client.query("COMMIT");

    console.log(`Dropped tenant "${subdomain}":`);
    console.log(`  schema dropped:   ${schema}`);
    console.log(`  registry rows removed: ${deleted.rowCount ?? 0}`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {
      // Original error is rethrown below.
    });
    throw error;
  } finally {
    client.release();
  }
}

main()
  .then(async () => {
    await disconnectAllTenantDbs();
    await closePool();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Drop failed: ${message}`);
    await disconnectAllTenantDbs().catch((e: unknown) => {
      console.error("Cleanup: failed to disconnect tenant clients:", e);
    });
    await closePool().catch((e: unknown) => {
      console.error("Cleanup: failed to close pool:", e);
    });
    process.exit(1);
  });
