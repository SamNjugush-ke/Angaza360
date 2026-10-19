// ===========================================================================
// Shared builders for the integration suite (Task T-A1).
//
// Every financial effect goes through the REAL services — procurement receives the
// stock, sales posts the sale, the ledger posts the entry. Products, suppliers and
// customers are created with the tenant Prisma client exactly as their routes do
// (src/routes/products.ts, customers.ts): those modules have no service layer, and
// creating a master-data row has no financial effect.
//
// GL figures are read INDEPENDENTLY with raw SQL over journal_lines, never through the
// service being tested, so a test can catch a service that reports one number and
// posts another.
// ===========================================================================

import { randomUUID } from "node:crypto";
import type { PrismaClient as TenantPrismaClient } from "../../src/generated/tenant/client";
import type { TaxClass } from "../../src/generated/tenant/enums";
import type { Cents } from "../../src/lib/money";
import { pool } from "../../src/db/pool";
import { assertValidSchemaName } from "../../src/db/tenant";
import { openShift } from "../../src/services/shifts";
import {
  approvePurchaseOrder,
  createPurchaseOrder,
  receivePurchaseOrder,
  type GoodsReceiptRow,
  type PurchaseOrderRow,
} from "../../src/services/procurement";

/** A fresh actor id. Tenant tables record actors as text; the platform registry is not joined. */
export function actorId(): string {
  return randomUUID();
}

/** A short unique suffix so repeated runs and repeated tests never collide on a unique key. */
export function uniq(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export async function createSupplier(db: TenantPrismaClient, name: string = uniq("Supplier")): Promise<string> {
  const supplier = await db.supplier.create({ data: { name } });
  return supplier.id;
}

export interface ProductSpec {
  price: Cents;
  costPrice?: Cents;
  taxClass?: TaxClass;
  sku?: string;
}

export async function createProduct(db: TenantPrismaClient, spec: ProductSpec): Promise<string> {
  const product = await db.product.create({
    data: {
      sku: spec.sku ?? uniq("SKU"),
      name: uniq("Product"),
      costPrice: spec.costPrice ?? 0n,
      price: spec.price,
      ...(spec.taxClass !== undefined ? { taxClass: spec.taxClass } : {}),
    },
  });
  return product.id;
}

export async function createCustomer(db: TenantPrismaClient, creditLimit: Cents): Promise<string> {
  const customer = await db.customer.create({ data: { name: uniq("Customer"), creditLimit } });
  return customer.id;
}

export interface ReceivedStock {
  order: PurchaseOrderRow;
  receipt: GoodsReceiptRow;
}

/**
 * Bring stock in through the real procurement path: DRAFT PO -> APPROVED -> received
 * in full. The receipt credits 2050 GRNI and debits 1200 through the inventory service.
 */
export async function receiveStock(
  db: TenantPrismaClient,
  supplierId: string,
  lines: ReadonlyArray<{ productId: string; quantity: string; unitCost: Cents }>,
): Promise<ReceivedStock> {
  const actor = actorId();
  const draft = await createPurchaseOrder(db, {
    supplierId,
    orderDate: new Date(),
    lines: lines.map((line) => ({ ...line })),
    createdById: actor,
  });
  const approved = await approvePurchaseOrder(db, draft.id, actor);
  const receipt = await receivePurchaseOrder(db, approved.id, {
    lines: approved.lines.map((line) => ({ purchaseOrderLineId: line.id, quantity: line.orderedQty })),
    receivedById: actor,
  });
  return { order: approved, receipt };
}

export interface Till {
  cashierId: string;
  shiftId: string;
}

export async function openTill(db: TenantPrismaClient): Promise<Till> {
  const cashierId = actorId();
  const shift = await openShift(db, cashierId, 0n);
  return { cashierId, shiftId: shift.id };
}

/** Net GL movement on an account, Σdebit − Σcredit, over every posted line. Independent SQL. */
export async function glNet(schema: string, accountCode: string): Promise<Cents> {
  assertValidSchemaName(schema);
  const result = await pool.query<{ v: string }>(
    `SELECT COALESCE(SUM(l."debit" - l."credit"), 0)::text AS v
       FROM "${schema}".journal_lines l
       JOIN "${schema}".accounts a ON a."id" = l."accountId"
      WHERE a."code" = $1`,
    [accountCode],
  );
  return BigInt(result.rows[0]?.v ?? "0");
}

/** Net movement of one account inside ONE journal entry, Σdebit − Σcredit. Independent SQL. */
export async function entryNet(schema: string, entryId: string, accountCode: string): Promise<Cents> {
  assertValidSchemaName(schema);
  const result = await pool.query<{ v: string }>(
    `SELECT COALESCE(SUM(l."debit" - l."credit"), 0)::text AS v
       FROM "${schema}".journal_lines l
       JOIN "${schema}".accounts a ON a."id" = l."accountId"
      WHERE l."entryId" = $1 AND a."code" = $2`,
    [entryId, accountCode],
  );
  return BigInt(result.rows[0]?.v ?? "0");
}

/** The account codes an entry touches. Independent SQL. */
export async function entryAccounts(schema: string, entryId: string): Promise<string[]> {
  assertValidSchemaName(schema);
  const result = await pool.query<{ code: string }>(
    `SELECT DISTINCT a."code" FROM "${schema}".journal_lines l
       JOIN "${schema}".accounts a ON a."id" = l."accountId"
      WHERE l."entryId" = $1 ORDER BY a."code"`,
    [entryId],
  );
  return result.rows.map((row) => row.code);
}

/** Σ Product.stockValue for the tenant. Independent SQL. */
export async function sumStockValue(schema: string): Promise<Cents> {
  assertValidSchemaName(schema);
  const result = await pool.query<{ v: string }>(
    `SELECT COALESCE(SUM("stockValue"), 0)::text AS v FROM "${schema}".products`,
  );
  return BigInt(result.rows[0]?.v ?? "0");
}

/** The id of an account in a tenant's chart. */
export async function accountIdOf(schema: string, code: string): Promise<string> {
  assertValidSchemaName(schema);
  const result = await pool.query<{ id: string }>(
    `SELECT "id" FROM "${schema}".accounts WHERE "code" = $1`,
    [code],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`Account ${code} is not in ${schema}'s chart.`);
  }
  return row.id;
}
