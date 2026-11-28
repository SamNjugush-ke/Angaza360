import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/tenant/client";
import { pool } from "./pool";

// Tenant schema resolution happens exclusively in Task 0.2's authenticated
// session middleware, which derives the schema name from the caller's
// verified tenant record. This module must never be called with a schema
// name that came directly from an HTTP request body, header, or query
// parameter — only from an already-authenticated, already-resolved tenant
// context.

const MAX_CACHED_CLIENTS = 50;

const tenantClients = new Map<string, PrismaClient>();

// The pg adapter qualifies Prisma-generated queries with the tenant schema but
// does NOT set the connection search_path. Raw SQL ($queryRaw) therefore cannot
// resolve unqualified tenant objects (sequences, tables). This registry lets the
// ledger service recover the schema for a given client so it can schema-qualify
// its raw SQL explicitly. A WeakMap so entries vanish with the client.
const clientSchemas = new WeakMap<PrismaClient, string>();

// Recover the tenant schema a client was created for. Throws if the client did
// not come from getTenantDb — raw SQL must never run against an unknown schema.
export function tenantSchemaFor(client: PrismaClient): string {
  const schema = clientSchemas.get(client);
  if (schema === undefined) {
    throw new Error(
      "tenantSchemaFor: this PrismaClient was not created by getTenantDb; its tenant schema is unknown.",
    );
  }
  return schema;
}

export function tenantSchemaName(subdomain: string): string {
  const slug = subdomain.toLowerCase().replace(/[^a-z0-9]/g, "_");
  return `tenant_${slug}`;
}

// Schema and subdomain identifiers cannot be parameterised in SQL — they are
// interpolated into DDL directly. These assertions are the ONLY defence; every
// caller that interpolates a schema name into raw SQL must call
// assertValidSchemaName first.

const SCHEMA_NAME_PATTERN = /^tenant_[a-z0-9_]{1,48}$/;

export function assertValidSchemaName(schema: string): void {
  if (schema === "public") {
    throw new Error(
      `Refusing to treat "public" as a tenant schema: it is the shared platform/registry schema and must never receive tenant DDL.`,
    );
  }
  if (schema === "information_schema") {
    throw new Error(
      `Refusing to treat "information_schema" as a tenant schema: it is a reserved system catalog.`,
    );
  }
  if (schema.startsWith("pg_")) {
    throw new Error(
      `Refusing to treat "${schema}" as a tenant schema: the "pg_" prefix is reserved for PostgreSQL system schemas.`,
    );
  }
  if (!SCHEMA_NAME_PATTERN.test(schema)) {
    throw new Error(
      `Invalid tenant schema name "${schema}": must match /^tenant_[a-z0-9_]{1,48}$/.`,
    );
  }
}

/** A tenant subdomain: 3–42 lowercase alphanumerics with internal hyphens. */
export const SUBDOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/;

/** The longest subdomain SUBDOMAIN_PATTERN admits. */
export const SUBDOMAIN_MAX_LENGTH = 42;

/** Subdomains no tenant may hold (platform hosts and names). */
export const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  "www",
  "api",
  "admin",
  "app",
  "angaza",
  "command",
  "dashboard",
  "static",
  "assets",
  "mail",
  "ftp",
]);

/** The non-throwing form of assertValidSubdomain (Task T-A6.1). */
export function isValidSubdomain(subdomain: string): boolean {
  return SUBDOMAIN_PATTERN.test(subdomain) && !RESERVED_SUBDOMAINS.has(subdomain);
}

export function assertValidSubdomain(subdomain: string): void {
  if (!SUBDOMAIN_PATTERN.test(subdomain)) {
    throw new Error(
      `Invalid subdomain "${subdomain}": must be lowercase alphanumeric with internal hyphens, 3–42 characters, and match /^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/.`,
    );
  }
  if (RESERVED_SUBDOMAINS.has(subdomain)) {
    throw new Error(
      `Subdomain "${subdomain}" is reserved and cannot be used for a tenant.`,
    );
  }
}

export function getTenantDb(schema: string): PrismaClient {
  const existing = tenantClients.get(schema);
  if (existing !== undefined) {
    // Refresh recency: delete and re-insert so this key is last in
    // iteration order (most-recently-used).
    tenantClients.delete(schema);
    tenantClients.set(schema, existing);
    return existing;
  }

  const adapter = new PrismaPg(pool, { schema });
  const client = new PrismaClient({ adapter });
  tenantClients.set(schema, client);
  clientSchemas.set(client, schema);

  if (tenantClients.size > MAX_CACHED_CLIENTS) {
    const oldestKey = tenantClients.keys().next().value;
    if (oldestKey !== undefined) {
      const evicted = tenantClients.get(oldestKey);
      tenantClients.delete(oldestKey);
      if (evicted !== undefined) {
        evicted.$disconnect().catch((error: unknown) => {
          console.error(`Failed to disconnect evicted tenant Prisma client for schema "${oldestKey}"`, error);
        });
      }
    }
  }

  return client;
}

export async function disconnectAllTenantDbs(): Promise<void> {
  const clients = Array.from(tenantClients.values());
  tenantClients.clear();
  await Promise.all(clients.map((client) => client.$disconnect()));
}
