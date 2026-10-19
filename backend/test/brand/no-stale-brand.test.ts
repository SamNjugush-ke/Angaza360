// ===========================================================================
// GUARD (Task T-A14): no legacy product name or domain survives in the backend.
//
// Every file under backend/ is read, except:
// node_modules, dist, generated clients, applied migrations (historical and
// immutable), .env.test (local, git-ignored), this guard itself (it must name the
// pattern) and src/config/brand.ts (the single source of truth).
// ===========================================================================

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const BACKEND_ROOT = join(__dirname, "..", "..");
const STALE = /angazaza|angaza msme lab|msme lab|msmelab/i;

const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "generated", "coverage", ".git"]);
const SKIPPED_FILES = new Set(
  [".env", ".env.test", "src/config/brand.ts", "test/brand/no-stale-brand.test.ts"].map((path) =>
    path.split("/").join(sep),
  ),
);

function isMigrationDirectory(path: string): boolean {
  const parts = relative(BACKEND_ROOT, path).split(sep);
  return parts.length === 3 && parts[0] === "prisma" && parts[2] === "migrations";
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name) || isMigrationDirectory(path)) continue;
      files.push(...sourceFiles(path));
    } else if (entry.isFile() && !SKIPPED_FILES.has(relative(BACKEND_ROOT, path))) {
      files.push(path);
    }
  }
  return files;
}

describe("no stale brand", () => {
  it("no backend file names the legacy product or domain", () => {
    const files = sourceFiles(BACKEND_ROOT);
    expect(files.length).toBeGreaterThan(100);
    const offenders = files
      .filter((path) => STALE.test(readFileSync(path, "utf8")))
      .map((path) => relative(BACKEND_ROOT, path));
    expect(offenders, `legacy brand found in: ${offenders.join(", ")}`).toEqual([]);
  });
});
