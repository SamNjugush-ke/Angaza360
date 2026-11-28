// ===========================================================================
// Product catalog editing (Task T-A7).
//
// This module edits what a product IS — its name, description, category, barcode,
// image, unit of measure, SKU, selling price and default cost — and whether it is
// ACTIVE. It never touches what the business HOLDS: stockCount, stockValue and avgCost
// remain writable only by src/services/inventory.ts (the engineering ledger "Single-Writer Service
// Boundaries"). Every write here names its columns explicitly, so a stock field can
// never ride along on an edit.
//
// COST PRICE IS NOT A REVALUATION. `costPrice` is the catalog's DEFAULT cost — a
// reference for future purchasing. Editing it changes nothing already held: the
// carrying value (`stockValue`) is authoritative and moves only by posted movements,
// `avgCost` is derived from it, and GL 1200 is untouched. Restating stock already on
// the shelf would rewrite a valuation the ledger has posted; a genuine revaluation is
// a stock movement with its own journal entry, never a catalog edit.
//
// SELLING PRICE IS FORWARD-ONLY: every sale line snapshots the price it was sold at.
//
// DEACTIVATION is a catalog state, not a stock event. A deactivated product cannot be
// sold (src/services/sales.ts) or restocked (src/services/inventory.ts refuses a
// receipt, an increase or an opening balance for it), but the stock it still owns
// stays owned, valued and counted in sum(stockValue) = GL(1200); it may still be
// transferred, written off, adjusted down or returned by a void.
// ===========================================================================

import type { PrismaClient as TenantPrismaClient } from "../generated/tenant/client";
import type { Product } from "../generated/tenant/client";

export class CatalogError extends Error {
  readonly status: 404 | 409;
  /** On a unique clash: which unique field it was (Task T-B-PRODUCT-DUP-FIELD). */
  readonly field: ProductUniqueField | null;
  constructor(status: 404 | 409, message: string, field: ProductUniqueField | null = null) {
    super(message);
    this.name = "CatalogError";
    this.status = status;
    this.field = field;
  }
}

// ---------------------------------------------------------------------------
// WHICH UNIQUE FIELD A DUPLICATE HIT (Task T-B-PRODUCT-DUP-FIELD). A product has two unique
// business fields, sku and barcode, and a 409 must name the right one. The answer is read from
// the violated constraint on Prisma's P2002 — never guessed from message text. Its FIELDS are at
// `meta.target` under the classic query engine and `meta.driverAdapterError.cause.constraint
// .fields` under the pg driver adapter up to Prisma 7.8; from Prisma 7.10 the adapter names the
// unique INDEX instead (`...constraint.index`), which is mapped by its migration-defined name.
// ---------------------------------------------------------------------------

export type ProductUniqueField = "sku" | "barcode";

export const DUPLICATE_MESSAGE: Readonly<Record<ProductUniqueField, string>> = {
  sku: "A product with this SKU already exists.",
  barcode: "A product with this barcode already exists.",
};

/** The products table's unique indexes (tenant migrations), by the field each one guards. */
const UNIQUE_INDEX_FIELD: Readonly<Record<string, ProductUniqueField>> = {
  products_sku_key: "sku",
  products_barcode_key: "barcode",
};

function fieldsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" ? [value] : [];
}

/** The unique field a P2002 violated, or null when it is not a sku / barcode clash. */
export function productUniqueClash(error: unknown): ProductUniqueField | null {
  if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "P2002") return null;
  const meta = "meta" in error && typeof error.meta === "object" && error.meta !== null ? (error.meta as Record<string, unknown>) : {};
  const adapter = meta["driverAdapterError"];
  const cause = typeof adapter === "object" && adapter !== null ? (adapter as Record<string, unknown>)["cause"] : undefined;
  const constraint = typeof cause === "object" && cause !== null ? (cause as Record<string, unknown>)["constraint"] : undefined;
  const named = typeof constraint === "object" && constraint !== null ? (constraint as Record<string, unknown>) : {};
  const index = typeof named["index"] === "string" ? UNIQUE_INDEX_FIELD[named["index"]] : undefined;
  const fields = [...fieldsOf(meta["target"]), ...fieldsOf(named["fields"]), ...(index !== undefined ? [index] : [])];
  if (fields.includes("barcode")) return "barcode";
  if (fields.includes("sku")) return "sku";
  return null;
}

/** The editable catalog fields. Money is already BigInt cents here. */
export interface ProductEdit {
  readonly sku?: string;
  readonly name?: string;
  readonly description?: string | null;
  readonly category?: string | null;
  readonly barcode?: string | null;
  readonly imageUrl?: string | null;
  readonly unitOfMeasure?: string;
  readonly price?: bigint;
  /** The DEFAULT cost for future purchases — never a revaluation of stock held. */
  readonly costPrice?: bigint;
}

async function requireProduct(db: TenantPrismaClient, id: string): Promise<Product> {
  const product = await db.product.findUnique({ where: { id } });
  if (product === null) {
    throw new CatalogError(404, `No product with id "${id}".`);
  }
  return product;
}

export async function updateProduct(db: TenantPrismaClient, id: string, edit: ProductEdit): Promise<Product> {
  await requireProduct(db, id);
  try {
    return await db.product.update({
      where: { id },
      // EXPLICIT columns only — nothing that values or counts stock.
      data: {
        ...(edit.sku !== undefined ? { sku: edit.sku } : {}),
        ...(edit.name !== undefined ? { name: edit.name } : {}),
        ...(edit.description !== undefined ? { description: edit.description } : {}),
        ...(edit.category !== undefined ? { category: edit.category } : {}),
        ...(edit.barcode !== undefined ? { barcode: edit.barcode } : {}),
        ...(edit.imageUrl !== undefined ? { imageUrl: edit.imageUrl } : {}),
        ...(edit.unitOfMeasure !== undefined ? { unitOfMeasure: edit.unitOfMeasure } : {}),
        ...(edit.price !== undefined ? { price: edit.price } : {}),
        ...(edit.costPrice !== undefined ? { costPrice: edit.costPrice } : {}),
      },
    });
  } catch (error) {
    const field = productUniqueClash(error);
    if (field !== null) {
      throw new CatalogError(409, DUPLICATE_MESSAGE[field], field);
    }
    throw error;
  }
}

export async function deactivateProduct(db: TenantPrismaClient, id: string): Promise<Product> {
  const product = await requireProduct(db, id);
  if (!product.isActive) {
    throw new CatalogError(409, "The product is already deactivated.");
  }
  return db.product.update({ where: { id }, data: { isActive: false } });
}

export async function reactivateProduct(db: TenantPrismaClient, id: string): Promise<Product> {
  const product = await requireProduct(db, id);
  if (product.isActive) {
    throw new CatalogError(409, "The product is already active.");
  }
  return db.product.update({ where: { id }, data: { isActive: true } });
}

// ---------------------------------------------------------------------------
// THE CATALOG LIST (Task T-B-PRODUCTS-SEARCH). Read-only. Every filter is optional and the
// total counts the FILTERED set, so a filtered list pages exactly like an unfiltered one.
// The order is TOTAL — newest first, then id — so LIMIT/OFFSET pages never overlap or drop a
// row, even for products created in the same instant (an import creates many at once).
// ---------------------------------------------------------------------------

export interface ProductListFilters {
  take: number;
  skip: number;
  /** Case-insensitive contains-match on name, sku or barcode; `%` and `_` are literals. */
  q?: string;
  /** Exact category, case-insensitive. */
  category?: string;
  active?: boolean;
  kind?: "GOOD" | "SERVICE";
}

/**
 * `q` as a LIKE pattern body that matches itself literally. Prisma's `contains` puts the
 * value inside `%…%` WITHOUT escaping it, so a `%` or `_` the user typed would be a wildcard
 * (searching "50%" would match "50 Off"). PostgreSQL's default LIKE escape is the backslash.
 */
export function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export async function listProducts(
  db: TenantPrismaClient,
  filters: ProductListFilters,
): Promise<{ data: Product[]; total: number }> {
  const raw = filters.q?.trim();
  const q = raw ? likeLiteral(raw) : undefined;
  const category = filters.category?.trim();
  const where = {
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { sku: { contains: q, mode: "insensitive" as const } },
            { barcode: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
    ...(category ? { category: { equals: category, mode: "insensitive" as const } } : {}),
    ...(filters.active !== undefined ? { isActive: filters.active } : {}),
    ...(filters.kind !== undefined ? { kind: filters.kind } : {}),
  };
  const [data, total] = await Promise.all([
    db.product.findMany({ where, take: filters.take, skip: filters.skip, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }),
    db.product.count({ where }),
  ]);
  return { data, total };
}

/**
 * The tenant's distinct non-blank categories, for a filter dropdown — sorted, and with
 * case variants ("Paint" / "paint") collapsed to the first spelling, because the list's
 * category filter matches case-insensitively and would treat them as one.
 */
export async function listProductCategories(db: TenantPrismaClient): Promise<string[]> {
  const rows = await db.product.findMany({
    where: { category: { not: null } },
    select: { category: true },
    distinct: ["category"],
    orderBy: { category: "asc" },
  });
  const seen = new Map<string, string>();
  for (const row of rows) {
    const value = row.category?.trim() ?? "";
    if (value !== "" && !seen.has(value.toLowerCase())) seen.set(value.toLowerCase(), value);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
}
