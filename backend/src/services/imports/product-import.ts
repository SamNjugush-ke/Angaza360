// ===========================================================================
// Product CSV import + OPENING INVENTORY (Task T-A11). NO MIGRATION.
//
// REUSES the T-A6.3 CSV framework (src/services/csv): the column schema below generates
// the downloadable template AND checks every upload's header, so the two cannot disagree.
// The flow is VALIDATE -> PREVIEW -> COMMIT, synchronous, with no staging table: the file
// is sent again at commit and validated again.
//
// PREVIEW validates every row — required fields, formats, a SKU and barcode unique within
// the file AND against existing products, and a SERVICE row carrying NO opening stock — and
// returns each row GREEN or with its errors, plus an all-green flag. It writes nothing.
//
// COMMIT IS ALL-OR-NOTHING-GREEN: it re-validates and refuses unless EVERY row is GREEN.
// Then, in ONE transaction, it creates every product and, for a GOOD row with an opening
// quantity, records OPENING INVENTORY through the inventory service's OPENING_BALANCE
// movement — the sanctioned opening-stock path, distinct from a purchase (no supplier,
// GRNI or AP) and from an adjustment. That movement is one valuation event: it moves
// stockValue, writes the movement and posts Dr 1200 / Cr 3000 Owner's Capital (the
// engine's opening-balance contra) with the SAME figure, so Σ stockValue = GL(1200) holds.
// The stock lands at the MAIN location. Because the transaction is atomic, a failure
// creates nothing; and because an imported SKU then EXISTS, committing the same file again
// is refused by the green-gate and creates nothing new.
//
// The product and stock tables are written only through their owners' rules: the products
// are created here (catalog creation, like POST /v1/products), and every stock column moves
// only inside src/services/inventory.ts.
// ===========================================================================

import { tenantSchemaFor } from "../../db/tenant";
import type { PrismaClient as TenantPrismaClient } from "../../generated/tenant/client";
import type { ProductType, TaxClass } from "../../generated/tenant/enums";
import { decimalToMilli } from "../../lib/inventory-math";
import { parseMoneyToCents, type Cents } from "../../lib/money";
import { csvTemplate, readCsv, type CsvRow, type CsvSchema } from "../csv/import";
import { recordStockMovementWithinTransaction } from "../inventory";

export const PRODUCT_IMPORT_SCHEMA: CsvSchema = {
  maxRows: 1000,
  columns: [
    { name: "sku", required: true, description: "Unique stock-keeping code." },
    { name: "name", required: true, description: "Product name." },
    { name: "category", required: false, description: "Optional category." },
    { name: "unitOfMeasure", required: false, description: "Defaults to unit." },
    { name: "kind", required: false, description: "GOOD (default) or SERVICE. A SERVICE carries no stock." },
    { name: "taxClass", required: false, description: "STANDARD_RATED (default), ZERO_RATED or EXEMPT." },
    { name: "costPrice", required: true, description: "Default purchase cost, e.g. 120.00." },
    { name: "price", required: true, description: "VAT-exclusive selling price, e.g. 150.00." },
    { name: "barcode", required: false, description: "Optional; unique." },
    { name: "openingQty", required: false, description: "Opening stock on hand (GOOD only), e.g. 12 or 2.5." },
    { name: "openingUnitCost", required: false, description: "Cost per unit of the opening stock; defaults to costPrice." },
  ],
};

const KINDS: readonly ProductType[] = ["GOOD", "SERVICE"];
const TAX_CLASSES: readonly TaxClass[] = ["STANDARD_RATED", "ZERO_RATED", "EXEMPT"];
const QUANTITY = /^[0-9]+(\.[0-9]{1,3})?$/;

export function productImportTemplate(): string {
  return csvTemplate(PRODUCT_IMPORT_SCHEMA);
}

export interface ImportRowError {
  readonly field: string;
  readonly message: string;
}

/** A row as it will be created, once it is GREEN. */
export interface ParsedProductRow {
  readonly sku: string;
  readonly name: string;
  readonly category: string | null;
  readonly unitOfMeasure: string;
  readonly kind: ProductType;
  readonly taxClass: TaxClass;
  readonly costPrice: Cents;
  readonly price: Cents;
  readonly barcode: string | null;
  /** Opening quantity as a decimal string, or null for none. */
  readonly openingQty: string | null;
  readonly openingUnitCost: Cents | null;
}

export interface PreviewRow {
  readonly rowNumber: number;
  readonly sku: string;
  readonly name: string;
  readonly status: "GREEN" | "RED";
  readonly errors: ImportRowError[];
}

export interface ImportPreview {
  readonly rows: PreviewRow[];
  readonly allGreen: boolean;
}

export class ProductImportError extends Error {
  readonly status: 400 | 409;
  constructor(status: 400 | 409, message: string) {
    super(message);
    this.name = "ProductImportError";
    this.status = status;
  }
}

function money(value: string, field: string, errors: ImportRowError[]): Cents | null {
  try {
    const cents = parseMoneyToCents(value);
    if (cents < 0n) {
      errors.push({ field, message: `${field} must not be negative.` });
      return null;
    }
    return cents;
  } catch {
    errors.push({ field, message: `${field} must be an amount such as 120.00.` });
    return null;
  }
}

function parseRow(row: CsvRow): { parsed: ParsedProductRow | null; errors: ImportRowError[] } {
  const v = row.values;
  const errors: ImportRowError[] = [];
  const sku = v["sku"] ?? "";
  const name = v["name"] ?? "";
  if (sku === "" || sku.length > 100) errors.push({ field: "sku", message: "A SKU of 1–100 characters is required." });
  if (name === "" || name.length > 200) errors.push({ field: "name", message: "A name of 1–200 characters is required." });

  const kindRaw = (v["kind"] ?? "").toUpperCase() || "GOOD";
  const kind = (KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as ProductType) : null;
  if (kind === null) errors.push({ field: "kind", message: "kind must be GOOD or SERVICE." });
  const taxRaw = (v["taxClass"] ?? "").toUpperCase() || "STANDARD_RATED";
  const taxClass = (TAX_CLASSES as readonly string[]).includes(taxRaw) ? (taxRaw as TaxClass) : null;
  if (taxClass === null) errors.push({ field: "taxClass", message: "taxClass must be STANDARD_RATED, ZERO_RATED or EXEMPT." });

  const costPrice = money(v["costPrice"] ?? "", "costPrice", errors);
  const price = money(v["price"] ?? "", "price", errors);

  const qtyRaw = v["openingQty"] ?? "";
  let openingQty: string | null = null;
  if (qtyRaw !== "") {
    if (!QUANTITY.test(qtyRaw)) {
      errors.push({ field: "openingQty", message: "openingQty is a quantity such as 12 or 2.5 (at most 3 decimals)." });
    } else if (decimalToMilli(qtyRaw) > 0n) {
      openingQty = qtyRaw;
    }
  }
  const unitCostRaw = v["openingUnitCost"] ?? "";
  let openingUnitCost: Cents | null = unitCostRaw === "" ? null : money(unitCostRaw, "openingUnitCost", errors);
  if (kind === "SERVICE" && (openingQty !== null || unitCostRaw !== "")) {
    errors.push({ field: "openingQty", message: "A SERVICE carries no stock: leave openingQty and openingUnitCost empty." });
  }
  if (openingQty !== null && openingUnitCost === null && unitCostRaw === "") {
    openingUnitCost = costPrice;
  }

  if (errors.length > 0 || kind === null || taxClass === null || costPrice === null || price === null) {
    return { parsed: null, errors };
  }
  return {
    parsed: {
      sku,
      name,
      category: (v["category"] ?? "") === "" ? null : (v["category"] ?? null),
      unitOfMeasure: (v["unitOfMeasure"] ?? "") === "" ? "unit" : (v["unitOfMeasure"] ?? "unit"),
      kind,
      taxClass,
      costPrice,
      price,
      barcode: (v["barcode"] ?? "") === "" ? null : (v["barcode"] ?? null),
      openingQty,
      openingUnitCost: openingQty === null ? null : openingUnitCost,
    },
    errors,
  };
}

interface Evaluated {
  readonly preview: ImportPreview;
  readonly parsed: Array<{ rowNumber: number; row: ParsedProductRow }>;
}

async function evaluate(db: TenantPrismaClient, csv: string): Promise<Evaluated> {
  let rows: CsvRow[];
  try {
    rows = readCsv(PRODUCT_IMPORT_SCHEMA, csv);
  } catch (error) {
    throw new ProductImportError(400, error instanceof Error ? error.message : "The file is not a valid product import.");
  }
  const results = rows.map((row) => ({ row, ...parseRow(row) }));

  const skus = results.map((r) => r.row.values["sku"] ?? "").filter((sku) => sku !== "");
  const barcodes = results.map((r) => r.row.values["barcode"] ?? "").filter((code) => code !== "");
  const existing = await db.product.findMany({
    where: { OR: [{ sku: { in: skus } }, ...(barcodes.length > 0 ? [{ barcode: { in: barcodes } }] : [])] },
    select: { sku: true, barcode: true },
  });
  const existingSkus = new Set(existing.map((p) => p.sku));
  const existingBarcodes = new Set(existing.flatMap((p) => (p.barcode === null ? [] : [p.barcode])));
  const count = (values: readonly string[], value: string) => values.filter((x) => x === value).length;

  const previewRows: PreviewRow[] = [];
  const parsed: Array<{ rowNumber: number; row: ParsedProductRow }> = [];
  for (const result of results) {
    const errors = [...result.errors];
    const sku = result.row.values["sku"] ?? "";
    const barcode = result.row.values["barcode"] ?? "";
    if (sku !== "" && count(skus, sku) > 1) errors.push({ field: "sku", message: `SKU ${sku} appears more than once in the file.` });
    if (sku !== "" && existingSkus.has(sku)) errors.push({ field: "sku", message: `SKU ${sku} already exists.` });
    if (barcode !== "" && count(barcodes, barcode) > 1) errors.push({ field: "barcode", message: `Barcode ${barcode} appears more than once in the file.` });
    if (barcode !== "" && existingBarcodes.has(barcode)) errors.push({ field: "barcode", message: `Barcode ${barcode} already belongs to a product.` });
    const status = errors.length === 0 && result.parsed !== null ? "GREEN" : "RED";
    previewRows.push({ rowNumber: result.row.rowNumber, sku, name: result.row.values["name"] ?? "", status, errors });
    if (status === "GREEN" && result.parsed !== null) parsed.push({ rowNumber: result.row.rowNumber, row: result.parsed });
  }
  return { preview: { rows: previewRows, allGreen: previewRows.every((row) => row.status === "GREEN") }, parsed };
}

/** Every row GREEN or with its errors. Writes nothing. */
export async function previewProductImport(db: TenantPrismaClient, csv: string): Promise<ImportPreview> {
  return (await evaluate(db, csv)).preview;
}

export interface CommittedProduct {
  readonly rowNumber: number;
  readonly productId: string;
  readonly sku: string;
  readonly kind: ProductType;
  /** The carrying value the opening stock entered at (0 when none). */
  readonly openingStockValue: Cents;
}

export async function commitProductImport(db: TenantPrismaClient, csv: string, createdBy: string): Promise<CommittedProduct[]> {
  const { preview, parsed } = await evaluate(db, csv);
  if (!preview.allGreen) {
    const red = preview.rows.filter((row) => row.status !== "GREEN");
    throw new ProductImportError(
      409,
      `The import cannot be committed while any row is not green: ${red.map((row) => `row ${row.rowNumber.toString()} (${row.errors.map((e) => e.field).join(", ")})`).join("; ")}.`,
    );
  }
  const schema = tenantSchemaFor(db);
  return db.$transaction(
    async (tx) => {
      const committed: CommittedProduct[] = [];
      for (const { rowNumber, row } of parsed) {
        const product = await tx.product.create({
          data: {
            sku: row.sku,
            name: row.name,
            category: row.category,
            unitOfMeasure: row.unitOfMeasure,
            kind: row.kind,
            taxClass: row.taxClass,
            costPrice: row.costPrice,
            price: row.price,
            barcode: row.barcode,
          },
        });
        let openingStockValue = 0n;
        if (row.openingQty !== null && row.openingUnitCost !== null) {
          const movement = await recordStockMovementWithinTransaction(tx, schema, {
            productId: product.id,
            movementType: "OPENING_BALANCE",
            quantity: row.openingQty,
            unitCost: row.openingUnitCost,
            reference: `import row ${rowNumber.toString()}`,
            notes: "Opening inventory (product import)",
            createdBy,
          });
          openingStockValue = movement.totalCost;
        }
        committed.push({ rowNumber, productId: product.id, sku: product.sku, kind: product.kind, openingStockValue });
      }
      return committed;
    },
    { timeout: 120_000 },
  );
}
