import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

// A single tenant datamodel migration, loaded from
// prisma/tenant/migrations/<name>/migration.sql. The tenant template is
// schema-neutral: it is executed against whichever tenant schema the caller
// has set as the active search_path, so it must never name a schema itself.

export interface TenantMigration {
  /** Directory name, e.g. "0001_init". Also the ledger row's unique key. */
  readonly name: string;
  /** Sanitised SQL, ready to execute under a tenant search_path. */
  readonly sql: string;
  /**
   * sha256 hex of the RAW (pre-sanitisation) file contents, with line endings
   * normalised to LF first. See normaliseLineEndings for why.
   */
  readonly checksum: string;
}

/**
 * Normalise CRLF (and lone CR) to LF before hashing.
 *
 * WHY THIS IS REQUIRED, not cosmetic: git on Windows with core.autocrlf=true
 * stores LF in the object database but writes CRLF into the working tree. The
 * same committed migration therefore has different BYTES depending on the
 * platform and the checkout — so hashing raw bytes made the "an applied
 * migration was edited" guard fire on a file nobody had touched. It fired for
 * real: a branch checkout was enough to make every migration look edited, and
 * it would have fired on any fresh Windows clone.
 *
 * This does NOT weaken the guard. Line endings are not semantic content in SQL;
 * any real change to a statement still changes the normalised hash. It removes
 * a false positive, and it is deliberately the LF form — which is what every
 * checksum already recorded in every tenant's _tenant_migrations ledger was
 * computed from, so no recorded checksum needs rewriting.
 */
function normaliseLineEndings(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// The Prisma tenant migrations live under backend/prisma, which is NOT copied
// into dist/. Resolving relative to this file's directory yields the same
// absolute path whether we run from src/db (tsx) or dist/db (node dist/):
// both sit two levels below backend/, so ../../prisma/... reaches it.
const MIGRATIONS_DIR = path.resolve(__dirname, "../../prisma/tenant/migrations");

// Prisma's `migrate diff` emits this line as boilerplate. It targets the
// shared "public" schema and must never run while provisioning a tenant.
const PUBLIC_SCHEMA_BOILERPLATE = /^\s*CREATE SCHEMA IF NOT EXISTS "public";\s*$/gm;

export function loadTenantMigrations(): TenantMigration[] {
  if (!existsSync(MIGRATIONS_DIR)) {
    throw new Error(
      `Tenant migrations directory not found at "${MIGRATIONS_DIR}". Expected prisma/tenant/migrations relative to the backend package.`,
    );
  }

  const directories = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const migrations: TenantMigration[] = [];

  for (const name of directories) {
    const sqlPath = path.join(MIGRATIONS_DIR, name, "migration.sql");
    if (!existsSync(sqlPath)) {
      continue;
    }

    const raw = normaliseLineEndings(readFileSync(sqlPath, "utf8"));
    const checksum = createHash("sha256").update(raw, "utf8").digest("hex");

    const sql = raw.replace(PUBLIC_SCHEMA_BOILERPLATE, "");

    if (sql.includes("CREATE SCHEMA")) {
      throw new Error(
        `Tenant migration "${name}" contains a CREATE SCHEMA statement after sanitisation. The tenant template must be schema-neutral; provisioning refuses to run against a regressed topology.`,
      );
    }
    if (sql.includes('"public".')) {
      throw new Error(
        `Tenant migration "${name}" contains a schema-qualified reference to "public". The tenant template must be schema-neutral; provisioning refuses to run against a regressed topology.`,
      );
    }

    migrations.push({ name, sql, checksum });
  }

  return migrations;
}
