import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { paths } from "@/lib/api/schema";
import { getJson, sendJson, withParams } from "@/lib/api/request";
import type { Role } from "@/lib/auth/landing";

// Inventory & locations: the shapes come from the generated API types, so they cannot drift from
// the backend. Money in a RESPONSE is a string of cents; money in a REQUEST is a decimal string in
// shillings ("150.00"). Quantities are decimal strings and are NOT money.

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Body<T> = T extends { requestBody?: { content: { "application/json": infer B } } } ? B : never;

export type StockList = Json<paths["/v1/inventory/stock"]["get"]["responses"][200]>;
export type StockRow = StockList["data"][number];
export type LocationStockList = Json<paths["/v1/inventory/stock/by-location"]["get"]["responses"][200]>;
export type LocationStockRow = LocationStockList["data"][number];
export type ProductSplit = Json<paths["/v1/inventory/stock/{productId}/by-location"]["get"]["responses"][200]>;
export type MovementPage = Json<paths["/v1/inventory/stock/{productId}/movements"]["get"]["responses"][200]>;
export type Movement = MovementPage["rows"][number];
export type MovementType = Movement["movementType"];
export type Valuation = Json<paths["/v1/inventory/valuation"]["get"]["responses"][200]>;
export type MovementResult = Json<paths["/v1/inventory/receipts"]["post"]["responses"][201]>;
export type TransferResult = Json<paths["/v1/inventory/transfers"]["post"]["responses"][201]>;
export type ReceiptBody = Body<paths["/v1/inventory/receipts"]["post"]>;
export type AdjustmentBody = Body<paths["/v1/inventory/adjustments"]["post"]>;
export type WriteOffBody = Body<paths["/v1/inventory/write-offs"]["post"]>;
export type TransferBody = Body<paths["/v1/inventory/transfers"]["post"]>;
export type LocationList = Json<paths["/v1/locations/"]["get"]["responses"][200]>;
export type Location = LocationList["data"][number];
export type LocationType = Location["type"];
export type LocationCreateBody = Body<paths["/v1/locations/"]["post"]>;
export type LocationUpdateBody = Body<paths["/v1/locations/{id}"]["patch"]>;
export type SupplierList = Json<paths["/v1/inventory/suppliers"]["get"]["responses"][200]>;
export type Supplier = SupplierList["data"][number];
export type SupplierCreateBody = Body<paths["/v1/inventory/suppliers"]["post"]>;
export type SupplierUpdateBody = Body<paths["/v1/inventory/suppliers/{id}"]["patch"]>;

// ---- Who may do what: the API's guards, mirrored so a role is never offered a refusal ----

const has = (roles: readonly Role[]) => (role: Role) => roles.includes(role);
const OWNER_MANAGER: readonly Role[] = ["MSME_OWNER", "MSME_MANAGER"];

export const stockPermissions = (role: Role) => ({
  /** POST /receipts, /adjustments, /transfers. */
  canMoveStock: has(["MSME_OWNER", "MSME_MANAGER", "WAREHOUSE_STAFF"])(role),
  /** POST /write-offs. */
  canWriteOff: has(OWNER_MANAGER)(role),
  /** GET /valuation and /stock-by-location — note: NOT the manager. */
  canSeeValuation: has(["MSME_OWNER", "ACCOUNTANT", "VIEWER_AUDITOR"])(role),
  /** POST / PATCH /v1/locations (and activate / deactivate). */
  canManageLocations: has(OWNER_MANAGER)(role),
  /** GET / POST / PATCH /v1/inventory/suppliers. */
  canUseSuppliers: has(OWNER_MANAGER)(role),
});
export type StockPermissions = ReturnType<typeof stockPermissions>;

// ---- Calls ----

const INV = "/inventory";

export const fetchStock = (belowReorder: boolean) => getJson<StockList>(withParams(`${INV}/stock`, { belowReorder: belowReorder ? "true" : undefined }));
export const fetchLocationStock = (locationId: string) => getJson<LocationStockList>(withParams(`${INV}/stock/by-location`, { locationId }));
export const fetchSplit = (productId: string) => getJson<ProductSplit>(`${INV}/stock/${encodeURIComponent(productId)}/by-location`);
export const fetchMovements = (productId: string, skip: number, take = 20, from?: string) =>
  getJson<MovementPage>(withParams(`${INV}/stock/${encodeURIComponent(productId)}/movements`, { take: take.toString(), skip: skip.toString(), from }));
export const fetchValuation = (asOf: string) => getJson<Valuation>(withParams(`${INV}/valuation`, { asOf }));
export const receiveStock = (body: ReceiptBody) => sendJson<MovementResult>("POST", `${INV}/receipts`, body);
export const adjustStock = (body: AdjustmentBody) => sendJson<MovementResult>("POST", `${INV}/adjustments`, body);
export const writeOffStock = (body: WriteOffBody) => sendJson<MovementResult>("POST", `${INV}/write-offs`, body);
export const transferStock = (body: TransferBody) => sendJson<TransferResult>("POST", `${INV}/transfers`, body);

export const fetchLocations = () => getJson<LocationList>("/locations");
export const createLocation = (body: LocationCreateBody) => sendJson<Location>("POST", "/locations", body);
export const updateLocation = (id: string, body: LocationUpdateBody) => sendJson<Location>("PATCH", `/locations/${encodeURIComponent(id)}`, body);
export const setLocationActive = (id: string, active: boolean) => sendJson<Location>("PATCH", `/locations/${encodeURIComponent(id)}/${active ? "activate" : "deactivate"}`);

export const fetchSuppliers = () => getJson<SupplierList>(`${INV}/suppliers`);
export const createSupplier = (body: SupplierCreateBody) => sendJson<Supplier>("POST", `${INV}/suppliers`, body);
export const updateSupplier = (id: string, body: SupplierUpdateBody) => sendJson<Supplier>("PATCH", `${INV}/suppliers/${encodeURIComponent(id)}`, body);

// ---- Queries ----

export const inventoryKeys = {
  all: ["inventory"] as const,
  stock: (belowReorder: boolean) => ["inventory", "stock", belowReorder] as const,
  locationStock: (locationId: string) => ["inventory", "location-stock", locationId] as const,
  split: (productId: string) => ["inventory", "split", productId] as const,
  movements: (productId: string, page: number) => ["inventory", "movements", productId, page] as const,
  valuation: (asOf: string) => ["inventory", "valuation", asOf] as const,
  locations: () => ["locations", "all"] as const,
  suppliers: () => ["suppliers"] as const,
};

export function useStock(belowReorder: boolean, enabled = true) {
  return useQuery({ queryKey: inventoryKeys.stock(belowReorder), queryFn: () => fetchStock(belowReorder), enabled, staleTime: 0 });
}
export function useLocationStock(locationId: string | null) {
  return useQuery({ queryKey: inventoryKeys.locationStock(locationId ?? ""), queryFn: () => fetchLocationStock(locationId ?? ""), enabled: locationId !== null, staleTime: 0 });
}
export function useSplit(productId: string) {
  return useQuery({ queryKey: inventoryKeys.split(productId), queryFn: () => fetchSplit(productId), staleTime: 0 });
}
export const MOVEMENTS_PAGE = 20;
export function useMovements(productId: string, page: number) {
  return useQuery({ queryKey: inventoryKeys.movements(productId, page), queryFn: () => fetchMovements(productId, page * MOVEMENTS_PAGE, MOVEMENTS_PAGE), placeholderData: keepPreviousData, staleTime: 0 });
}
export function useValuation(asOf: string, enabled: boolean) {
  return useQuery({ queryKey: inventoryKeys.valuation(asOf), queryFn: () => fetchValuation(asOf), enabled, staleTime: 0 });
}
export function useLocations(enabled = true) {
  return useQuery({ queryKey: inventoryKeys.locations(), queryFn: fetchLocations, enabled, staleTime: 0 });
}
export function useSuppliers(enabled: boolean) {
  return useQuery({ queryKey: inventoryKeys.suppliers(), queryFn: fetchSuppliers, enabled });
}

/** After any stock write: every stock read (levels, splits, history, valuation) is stale. */
export function useInvalidateStock(): () => Promise<void> {
  const client = useQueryClient();
  return useCallback(async () => {
    await client.invalidateQueries({ queryKey: inventoryKeys.all });
    await client.invalidateQueries({ queryKey: ["catalog"] });
  }, [client]);
}

// ---- Words for the API's enums ----

export const MOVEMENT_LABEL: Readonly<Record<MovementType, string>> = {
  PURCHASE_RECEIPT: "Received",
  SALE: "Sold",
  SALE_RETURN: "Returned (void)",
  PURCHASE_RETURN: "Returned to supplier",
  ADJUSTMENT_INCREASE: "Adjusted up",
  ADJUSTMENT_DECREASE: "Adjusted down",
  WRITE_OFF: "Written off",
  TRANSFER_IN: "Transferred in",
  TRANSFER_OUT: "Transferred out",
  OPENING_BALANCE: "Opening stock",
};

const OUTBOUND: ReadonlySet<MovementType> = new Set(["SALE", "PURCHASE_RETURN", "ADJUSTMENT_DECREASE", "WRITE_OFF", "TRANSFER_OUT"]);
/** "+12" or "−3": the direction of a movement, read from its type. */
export const signedQuantity = (type: MovementType, quantity: string) => `${OUTBOUND.has(type) ? "−" : "+"}${quantity}`;

export const LOCATION_TYPE_LABEL: Readonly<Record<LocationType, string>> = {
  MAIN: "Main",
  POS: "Till",
  ECOMMERCE: "Online shop",
  BRANCH: "Branch",
  ATTENDANT: "Attendant",
};
