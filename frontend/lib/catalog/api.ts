import { failureMessage } from "@/lib/api/messages";
import { apiFetch } from "@/lib/api/browser";
import { ApiHttpError, withQuery } from "@/lib/dashboard/fetch";
import type {
  CategoryList,
  ImportCommit,
  ImportPreview,
  Product,
  ProductCreateBody,
  ProductEditBody,
  ProductFilters,
  ProductList,
  ProductUniqueField,
  ReorderPolicyBody,
  TaxClass,
} from "./types";

// The catalog's calls, through the BFF proxy (CSRF and the single-flight refresh come with
// apiFetch). Every refusal is thrown as an ApiHttpError carrying the backend's own message —
// those messages are written for people ("Another product already uses that barcode.") and the
// forms show them as they are.

export const PRODUCTS = "/products";

/** A 409 on create / edit naming the unique field that clashed (sku or barcode). */
export class ProductConflictError extends ApiHttpError {
  readonly field: ProductUniqueField;

  constructor(message: string, field: ProductUniqueField) {
    super(409, message);
    this.name = "ProductConflictError";
    this.field = field;
  }
}

function conflictFieldOf(body: unknown): ProductUniqueField | null {
  if (typeof body !== "object" || body === null || !("field" in body)) return null;
  return body.field === "sku" || body.field === "barcode" ? body.field : null;
}

export function productListPath(filters: ProductFilters, skip: number, take: number): string {
  const q = filters.q.trim();
  return withQuery(PRODUCTS, {
    take,
    skip,
    q: q === "" ? undefined : q,
    category: filters.category === "" ? undefined : filters.category,
    kind: filters.kind === "" ? undefined : filters.kind,
    active: filters.active === "" ? undefined : filters.active,
  });
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await apiFetch(path, init);
  } catch {
    throw new ApiHttpError(0, "The service could not be reached. Check your connection and try again.");
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message = failureMessage(
      response.status,
      typeof body === "object" && body !== null && "message" in body && typeof body.message === "string" ? body.message : null,
    );
    const field = response.status === 409 ? conflictFieldOf(body) : null;
    throw field !== null ? new ProductConflictError(message, field) : new ApiHttpError(response.status, message);
  }
  return response;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const csvInit = (csv: string): RequestInit => ({ method: "POST", headers: { "content-type": "text/csv" }, body: csv });

export async function fetchProducts(filters: ProductFilters, skip: number, take: number): Promise<ProductList> {
  return (await (await call(productListPath(filters, skip, take))).json()) as ProductList;
}

export async function fetchCategories(): Promise<CategoryList> {
  return (await (await call(`${PRODUCTS}/categories`)).json()) as CategoryList;
}

export async function createProduct(body: ProductCreateBody): Promise<Product> {
  return (await (await call(PRODUCTS, jsonInit("POST", body))).json()) as Product;
}

export async function updateProduct(id: string, body: ProductEditBody): Promise<Product> {
  return (await (await call(`${PRODUCTS}/${encodeURIComponent(id)}`, jsonInit("PATCH", body))).json()) as Product;
}

export async function setReorderPolicy(id: string, body: ReorderPolicyBody): Promise<Product> {
  return (await (await call(`${PRODUCTS}/${encodeURIComponent(id)}/reorder-policy`, jsonInit("PATCH", body))).json()) as Product;
}

export async function setTaxClass(id: string, taxClass: TaxClass): Promise<Product> {
  return (await (await call(`${PRODUCTS}/${encodeURIComponent(id)}/tax-class`, jsonInit("PATCH", { taxClass }))).json()) as Product;
}

/** POST /:id/deactivate | /:id/reactivate — no body. */
export async function setActive(id: string, active: boolean): Promise<Product> {
  const path = `${PRODUCTS}/${encodeURIComponent(id)}/${active ? "reactivate" : "deactivate"}`;
  return (await (await call(path, { method: "POST" })).json()) as Product;
}

export async function fetchImportTemplate(): Promise<string> {
  return (await call(`${PRODUCTS}/import/template`, { headers: { accept: "text/csv" } })).text();
}

export async function previewImport(csv: string): Promise<ImportPreview> {
  return (await (await call(`${PRODUCTS}/import/preview`, csvInit(csv))).json()) as ImportPreview;
}

export async function commitImport(csv: string): Promise<ImportCommit> {
  return (await (await call(`${PRODUCTS}/import/commit`, csvInit(csv))).json()) as ImportCommit;
}
