import type { components, paths } from "@/lib/api/schema";

// The catalog's shapes, taken from the generated API types (lib/api/schema.d.ts) so they cannot
// drift from the backend. Money stays a STRING of cents; quantities stay decimal strings.

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;

export type ProductList = Json<paths["/v1/products/"]["get"]["responses"][200]>;
export type Product = ProductList["data"][number];
export type ProductKind = Product["kind"];
export type TaxClass = Product["taxClass"];
export type ProductCreateBody = NonNullable<paths["/v1/products/"]["post"]["requestBody"]>["content"]["application/json"];
export type ProductEditBody = NonNullable<paths["/v1/products/{id}"]["patch"]["requestBody"]>["content"]["application/json"];
export type ReorderPolicyBody = NonNullable<paths["/v1/products/{id}/reorder-policy"]["patch"]["requestBody"]>["content"]["application/json"];
export type CategoryList = Json<paths["/v1/products/categories"]["get"]["responses"][200]>;
export type ImportPreview = Json<paths["/v1/products/import/preview"]["post"]["responses"][200]>;
export type ImportPreviewRow = ImportPreview["rows"][number];
export type ImportCommit = Json<paths["/v1/products/import/commit"]["post"]["responses"][201]>;
/** A create / edit 409: the standard envelope plus WHICH unique field clashed. */
export type ProductConflict = components["schemas"]["ProductConflict"];
export type ProductUniqueField = ProductConflict["field"];

/** The list's filters as the API takes them — `active` travels as the STRING "true" | "false". */
export interface ProductFilters {
  q: string;
  category: string;
  kind: "" | ProductKind;
  /** "true" active only (the default view), "false" deactivated only, "" all. */
  active: "" | "true" | "false";
}

export const DEFAULT_FILTERS: ProductFilters = { q: "", category: "", kind: "", active: "true" };

export const PAGE_SIZE = 20;

export const TAX_CLASSES: readonly TaxClass[] = ["STANDARD_RATED", "ZERO_RATED", "EXEMPT"];

export const TAX_CLASS_LABEL: Readonly<Record<TaxClass, string>> = {
  STANDARD_RATED: "Standard-rated",
  ZERO_RATED: "Zero-rated",
  EXEMPT: "Exempt",
};

export const KIND_LABEL: Readonly<Record<ProductKind, string>> = { GOOD: "Good", SERVICE: "Service" };
