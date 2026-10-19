import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { parseMoneyToCents } from "../lib/money";
import { decimalToMilli } from "../lib/inventory-math";
import { zProduct, zProductType, zTaxClass } from "../schemas/models";
import { CatalogError, deactivateProduct, reactivateProduct, updateProduct } from "../services/catalog";
import {
  commitProductImport,
  previewProductImport,
  ProductImportError,
  productImportTemplate,
} from "../services/imports/product-import";
import { RATE_LIMITS } from "../plugins/security";
import {
  badRequest,
  conflict,
  errorBody,
  errorResponses,
  notFound,
  SECURE,
  zIdParam,
  zMoneyNonNegative,
  zPagination,
  zPaginationResult,
  zCentsString,
  zQuantity,
} from "../schemas/common";

// This route proves the authenticated tenant context end-to-end: every query
// runs against request.tenantDb, whose schema is derived solely from the
// verified session.
//
// Money arrives as a decimal STRING and is converted to BigInt cents. A JSON
// number is rejected by the schema — a number can silently lose precision
// before it ever reaches us, which is unacceptable for money.

const zProductCreate = z.object({
  sku: z.string().trim().min(1, "sku is required."),
  name: z.string().trim().min(1, "name is required."),
  costPrice: zMoneyNonNegative,
  price: zMoneyNonNegative,
  taxClass: zTaxClass.optional().meta({
    description:
      "Defaults to STANDARD_RATED. Decides the VAT every future sale of this product charges — for a VAT-registered tenant only; a non-registered tenant charges none on anything.",
  }),
  barcode: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  unitOfMeasure: z.string().min(1).optional(),
  supplierId: z.string().min(1).optional(),
  kind: zProductType.optional().meta({
    description:
      "Defaults to GOOD. A SERVICE carries no stock, ever: it cannot be received or moved, and its sale posts no cost of sales. Fixed once created.",
  }),
});

function sendCatalogError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof CatalogError) {
    return reply.code(error.status).send(error.status === 404 ? notFound(error.message) : conflict(error.message));
  }
  throw error;
}

function sendImportError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ProductImportError) {
    return reply.code(error.status).send(error.status === 400 ? badRequest(error.message) : conflict(error.message));
  }
  throw error;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}

export async function productRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const baseGuards = [app.requireAuth, app.requireTenant];

  api.route({
    method: "GET",
    url: "/",
    preHandler: [
      ...baseGuards,
      app.requireRole(
        "MSME_OWNER",
        "MSME_MANAGER",
        "WAREHOUSE_STAFF",
        "CASHIER",
        "VIEWER_AUDITOR",
      ),
    ],
    schema: {
      tags: ["Products"],
      summary: "List products",
      description:
        "The tenant's product catalog, newest first. Money fields (costPrice, price, avgCost, stockValue) are strings of KES cents.",
      security: SECURE,
      querystring: zPagination,
      response: {
        200: z.object({ data: z.array(zProduct), pagination: zPaginationResult }),
        ...errorResponses(400, 401, 403),
      },
    },
    handler: async (request, reply) => {
      const { take, skip } = request.query;
      const db = request.tenantDb;
      const [data, total] = await Promise.all([
        db.product.findMany({ take, skip, orderBy: { createdAt: "desc" } }),
        db.product.count(),
      ]);
      return reply.code(200).send({ data, pagination: { take, skip, total } });
    },
  });

  api.route({
    method: "POST",
    url: "/",
    preHandler: [
      ...baseGuards,
      app.requireRole("MSME_OWNER", "MSME_MANAGER", "WAREHOUSE_STAFF"),
    ],
    schema: {
      tags: ["Products"],
      summary: "Create a product",
      description:
        "costPrice and price are decimal strings (e.g. \"1800.00\") and are stored as BigInt KES cents. A JSON number is rejected.",
      security: SECURE,
      body: zProductCreate,
      response: {
        201: zProduct,
        ...errorResponses(400, 401, 403, 409),
      },
    },
    handler: async (request, reply) => {
      const body = request.body;
      try {
        const created = await request.tenantDb.product.create({
          data: {
            sku: body.sku,
            name: body.name,
            costPrice: parseMoneyToCents(body.costPrice),
            price: parseMoneyToCents(body.price),
            ...(body.taxClass !== undefined ? { taxClass: body.taxClass } : {}),
            // A product is created with NO stock (stock arrives only through the
            // inventory service), so a SERVICE is born satisfying 0027's no-stock CHECK.
            ...(body.kind !== undefined ? { kind: body.kind } : {}),
            barcode: body.barcode ?? null,
            description: body.description ?? null,
            category: body.category ?? null,
            supplierId: body.supplierId ?? null,
            ...(body.unitOfMeasure !== undefined
              ? { unitOfMeasure: body.unitOfMeasure }
              : {}),
          },
        });
        return reply.code(201).send(created);
      } catch (error) {
        if (isUniqueViolation(error)) {
          return reply
            .code(409)
            .send(conflict(`A product with sku "${body.sku}" already exists.`));
        }
        throw error;
      }
    },
  });

  // Reorder policy (Task 10.2). DELIBERATELY NARROW: this sets the two fields
  // that drive the low-stock alert feed and nothing else. It is not a general
  // product-update route (that is PATCH /:id, added by Task T-A7, which does not
  // touch reorder policy). Without this the alert thresholds
  // the feed reads would be unreachable from the API, which would leave
  // low-stock alerting configurable only by hand in the database.
  //
  // These are QUANTITIES (Decimal(14,3)), not money, and not stock: they are
  // catalog policy. The single-writer rule is untouched — stockCount,
  // stockValue and avgCost remain writable only by the inventory service.
  api.route({
    method: "PATCH",
    url: "/:id/reorder-policy",
    preHandler: [
      ...baseGuards,
      app.requireRole("MSME_OWNER", "MSME_MANAGER", "WAREHOUSE_STAFF"),
    ],
    schema: {
      tags: ["Inventory"],
      summary: "Set a product's reorder threshold and reorder quantity",
      description:
        "Drives the low-stock alert feed at `GET /v1/allocations/low-stock`, where the threshold is applied PER LOCATION SLICE. A threshold of 0 raises no alert — that is how a product opts out. `reorderQuantity` is the suggested top-up; send null to clear it.\n\n" +
        "Quantities are decimal strings and are NOT money. This route sets catalog policy only: it cannot change stockCount, stockValue or avgCost, which only the inventory service may move.",
      security: SECURE,
      params: zIdParam,
      body: z
        .object({
          minStockThreshold: zQuantity.optional(),
          reorderQuantity: zQuantity.nullable().optional(),
        })
        .refine(
          (body) =>
            body.minStockThreshold !== undefined || body.reorderQuantity !== undefined,
          { message: "Supply minStockThreshold, reorderQuantity, or both." },
        ),
      response: { 200: zProduct, ...errorResponses(400, 401, 403, 404) },
    },
    handler: async (request, reply) => {
      const { id } = request.params;
      const body = request.body;

      if (body.minStockThreshold !== undefined && decimalToMilli(body.minStockThreshold) < 0n) {
        return reply.code(400).send(badRequest("minStockThreshold must not be negative."));
      }
      if (
        body.reorderQuantity !== undefined &&
        body.reorderQuantity !== null &&
        decimalToMilli(body.reorderQuantity) <= 0n
      ) {
        return reply
          .code(400)
          .send(badRequest("reorderQuantity must be positive, or null to clear it."));
      }

      const existing = await request.tenantDb.product.findUnique({ where: { id } });
      if (existing === null) {
        return reply.code(404).send(notFound(`No product with id "${id}".`));
      }

      const updated = await request.tenantDb.product.update({
        where: { id },
        data: {
          ...(body.minStockThreshold !== undefined
            ? { minStockThreshold: body.minStockThreshold }
            : {}),
          ...(body.reorderQuantity !== undefined
            ? { reorderQuantity: body.reorderQuantity }
            : {}),
        },
      });
      return reply.code(200).send(updated);
    },
  });

  // ---- Catalog editing (Task T-A7) -------------------------------------------
  // The general product PATCH and the active switch, over src/services/catalog.ts.
  // None of them can move stock: stockCount, stockValue and avgCost stay writable
  // only by the inventory service. COST PRICE IS NOT A REVALUATION — editing it sets
  // the default for future purchases and leaves the carrying value and GL 1200 alone.

  api.route({
    method: "PATCH",
    url: "/:id",
    preHandler: [...baseGuards, app.requireRole("MSME_OWNER", "MSME_MANAGER", "WAREHOUSE_STAFF")],
    schema: {
      tags: ["Products"],
      summary: "Edit a product's catalog fields",
      description:
        "Edits name, description, category, barcode, imageUrl, unitOfMeasure, sku, price (the VAT-exclusive selling price — future sales only; every sale line snapshots its price) and costPrice. **costPrice is the DEFAULT cost for future purchases; editing it never revalues stock already held** — stockValue, avgCost, stockCount and GL 1200 are untouched. sku and barcode stay unique (409). Send null to clear an optional field. Tax class and reorder policy have their own routes.",
      security: SECURE,
      params: zIdParam,
      body: z
        .object({
          sku: z.string().trim().min(1).optional(),
          name: z.string().trim().min(1).optional(),
          description: z.string().min(1).nullable().optional(),
          category: z.string().min(1).nullable().optional(),
          barcode: z.string().min(1).nullable().optional(),
          imageUrl: z.string().min(1).max(2048).nullable().optional(),
          unitOfMeasure: z.string().min(1).optional(),
          price: zMoneyNonNegative.optional(),
          costPrice: zMoneyNonNegative.optional(),
        })
        .refine((body) => Object.values(body).some((value) => value !== undefined), {
          message: "Supply at least one field to change.",
        }),
      response: { 200: zProduct, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const body = request.body;
      try {
        const updated = await updateProduct(request.tenantDb, request.params.id, {
          ...(body.sku !== undefined ? { sku: body.sku } : {}),
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.category !== undefined ? { category: body.category } : {}),
          ...(body.barcode !== undefined ? { barcode: body.barcode } : {}),
          ...(body.imageUrl !== undefined ? { imageUrl: body.imageUrl } : {}),
          ...(body.unitOfMeasure !== undefined ? { unitOfMeasure: body.unitOfMeasure } : {}),
          ...(body.price !== undefined ? { price: parseMoneyToCents(body.price) } : {}),
          ...(body.costPrice !== undefined ? { costPrice: parseMoneyToCents(body.costPrice) } : {}),
        });
        return reply.code(200).send(updated);
      } catch (error) {
        return sendCatalogError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/:id/deactivate",
    preHandler: [...baseGuards, app.requireRole("MSME_OWNER", "MSME_MANAGER")],
    schema: {
      tags: ["Products"],
      summary: "Deactivate a product",
      description:
        "A deactivated product can be neither sold nor restocked. Allowed even while it holds stock: that stock stays owned, valued and counted in Σ stockValue = GL 1200, and can still be transferred, adjusted down or written off.",
      security: SECURE,
      params: zIdParam,
      response: { 200: zProduct, ...errorResponses(401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      try {
        return reply.code(200).send(await deactivateProduct(request.tenantDb, request.params.id));
      } catch (error) {
        return sendCatalogError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/:id/reactivate",
    preHandler: [...baseGuards, app.requireRole("MSME_OWNER", "MSME_MANAGER")],
    schema: {
      tags: ["Products"],
      summary: "Reactivate a product",
      security: SECURE,
      params: zIdParam,
      response: { 200: zProduct, ...errorResponses(401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      try {
        return reply.code(200).send(await reactivateProduct(request.tenantDb, request.params.id));
      } catch (error) {
        return sendCatalogError(reply, error);
      }
    },
  });

  // A NARROW tax-class route (Task 3B.1), in the same spirit as reorder-policy: the
  // one field VAT correctness needs, kept OUT of the general PATCH (Task T-A7) and
  // limited to owner and manager.
  //
  // FORWARD-ONLY BY CONSTRUCTION. A sale line SNAPSHOTS its class and the KRA code it
  // was charged under, so reclassifying a product changes the next sale and never a
  // past one. Owner or manager only: the class decides what VAT the business charges
  // its customers and declares to KRA.
  api.route({
    method: "PATCH",
    url: "/:id/tax-class",
    preHandler: [...baseGuards, app.requireRole("MSME_OWNER", "MSME_MANAGER")],
    schema: {
      tags: ["Products"],
      summary: "Set a product's VAT tax class",
      description:
        "STANDARD_RATED charges the standard rate in force (configured on the effective statutory schedule, never on the product); ZERO_RATED is vatable at 0%; EXEMPT is outside VAT. Only a VAT-registered tenant charges output VAT at all. Affects FUTURE sales only — every sale line snapshots the class it was charged under.",
      security: SECURE,
      params: zIdParam,
      body: z.object({ taxClass: zTaxClass }),
      response: { 200: zProduct, ...errorResponses(400, 401, 403, 404) },
    },
    handler: async (request, reply) => {
      const { id } = request.params;
      const existing = await request.tenantDb.product.findUnique({ where: { id }, select: { id: true } });
      if (existing === null) {
        return reply.code(404).send(notFound(`No product with id "${id}".`));
      }
      const updated = await request.tenantDb.product.update({
        where: { id },
        data: { taxClass: request.body.taxClass },
      });
      return reply.code(200).send(updated);
    },
  });

  // ---- Product CSV import + opening inventory (Task T-A11) ----------------------
  // Over the T-A6.3 CSV framework, via src/services/imports/product-import.ts. The CSV
  // is the request body (Content-Type: text/csv). Preview writes nothing; commit is
  // refused unless EVERY row is green, then creates the products and their opening
  // inventory (OPENING_BALANCE: Dr 1200 / Cr 3000) in one transaction.
  const importRoles = app.requireRole("MSME_OWNER", "MSME_MANAGER", "WAREHOUSE_STAFF");
  const zImportPreview = z.object({
    rows: z.array(
      z.object({
        rowNumber: z.number().int(),
        sku: z.string(),
        name: z.string(),
        status: z.enum(["GREEN", "RED"]),
        errors: z.array(z.object({ field: z.string(), message: z.string() })),
      }),
    ),
    allGreen: z.boolean(),
  });

  api.route({
    method: "GET",
    url: "/import/template",
    preHandler: [...baseGuards, importRoles],
    schema: {
      tags: ["Products"],
      summary: "Download the product import CSV template",
      description:
        "A text/csv header row: sku, name, category, unitOfMeasure, kind, taxClass, costPrice, price, barcode, openingQty, openingUnitCost. Required: sku, name, costPrice, price.",
      security: SECURE,
      response: { 200: z.string().meta({ description: "text/csv" }), ...errorResponses(401, 403) },
    },
    handler: async (_request, reply) =>
      reply
        .code(200)
        .type("text/csv; charset=utf-8")
        .header("content-disposition", "attachment; filename=product-import-template.csv")
        .serializer((payload: unknown) => String(payload))
        .send(productImportTemplate()),
  });

  api.route({
    method: "POST",
    url: "/import/preview",
    config: { rateLimit: RATE_LIMITS.SENSITIVE },
    preHandler: [...baseGuards, importRoles],
    schema: {
      tags: ["Products"],
      summary: "Preview a product import (text/csv body)",
      description:
        "Validates every row — required fields, money and quantity formats, kind and tax class, a SKU and barcode unique within the file and against existing products, and NO opening stock on a SERVICE — and returns each row GREEN or with its errors, plus allGreen. Writes nothing. A file-level problem is a 400.",
      security: SECURE,
      body: z.string().meta({ description: "The CSV text." }),
      response: { 200: zImportPreview, ...errorResponses(400, 401, 403, 429) },
    },
    handler: async (request, reply) => {
      try {
        return reply.code(200).send(await previewProductImport(request.tenantDb, request.body));
      } catch (error) {
        return sendImportError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/import/commit",
    config: { rateLimit: RATE_LIMITS.SENSITIVE },
    preHandler: [...baseGuards, importRoles],
    schema: {
      tags: ["Products"],
      summary: "Commit a product import: create the products and their opening inventory",
      description:
        "Re-validates the same CSV and REFUSES (409, naming the rows) unless every row is GREEN. Then, in ONE transaction, creates each product and records each GOOD row's opening quantity through the OPENING_BALANCE stock movement (Dr 1200 Inventory / Cr 3000 Owner's Capital, at the MAIN location), so Σ stockValue = GL(1200) holds. Committing the same file again is refused (its SKUs now exist) and creates nothing.",
      security: SECURE,
      body: z.string().meta({ description: "The CSV text." }),
      response: {
        201: z.object({
          created: z.array(
            z.object({
              rowNumber: z.number().int(),
              productId: z.string(),
              sku: z.string(),
              kind: z.enum(["GOOD", "SERVICE"]),
              openingStockValue: zCentsString,
            }),
          ),
        }),
        ...errorResponses(400, 401, 403, 409, 429),
      },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      try {
        return reply.code(201).send({ created: await commitProductImport(request.tenantDb, request.body, auth.userId) });
      } catch (error) {
        return sendImportError(reply, error);
      }
    },
  });
}
