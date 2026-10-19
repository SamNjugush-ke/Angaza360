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
  constructor(status: 404 | 409, message: string) {
    super(message);
    this.name = "CatalogError";
    this.status = status;
  }
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

function uniqueViolationField(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "P2002") {
    return null;
  }
  const text = JSON.stringify(error);
  if (text.includes("barcode")) return "barcode";
  if (text.includes("sku")) return "sku";
  return "sku or barcode";
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
    const field = uniqueViolationField(error);
    if (field !== null) {
      throw new CatalogError(409, `Another product already uses that ${field}.`);
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
