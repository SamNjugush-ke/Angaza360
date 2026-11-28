import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { paths } from "@/lib/api/schema";
import { getJson, sendJson, withParams } from "@/lib/api/request";
import type { Role } from "@/lib/auth/landing";
import { fromMilli, isQuantity, toMilli } from "@/lib/pos/quantity";

// Procurement: purchase orders through their lifecycle and the goods receipts (GRNs) that receive
// them. Shapes from the generated API types; money in a REQUEST is shillings ("150.00"), in a
// RESPONSE cents. The screen does no accounting: a GRN's postings are read from the ledger.

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Body<T> = T extends { requestBody?: { content: { "application/json": infer B } } } ? B : never;

export type PurchaseOrderList = Json<paths["/v1/procurement/purchase-orders"]["get"]["responses"][200]>;
export type PurchaseOrder = PurchaseOrderList["data"][number];
export type PurchaseOrderLine = PurchaseOrder["lines"][number];
export type PurchaseOrderStatus = PurchaseOrder["status"];
export type PurchaseOrderCreateBody = Body<paths["/v1/procurement/purchase-orders"]["post"]>;
export type PurchaseOrderUpdateBody = Body<paths["/v1/procurement/purchase-orders/{id}"]["patch"]>;
export type ReceiveBody = Body<paths["/v1/procurement/purchase-orders/{id}/receive"]["post"]>;
export type GoodsReceipt = Json<paths["/v1/procurement/goods-receipts/{id}"]["get"]["responses"][200]>;
export type JournalEntry = Json<paths["/v1/ledger/entries/{id}"]["get"]["responses"][200]>;

// ---- Who may do what (the API's guards) ----

const has = (roles: readonly Role[]) => (role: Role) => roles.includes(role);
const OWNER_MANAGER: readonly Role[] = ["MSME_OWNER", "MSME_MANAGER"];

export const procurementPermissions = (role: Role) => ({
  /**
   * Raising a PO needs a supplier, and only the owner and manager may read suppliers, so they are
   * the ones offered "Raise". (The API also lets warehouse staff create one; with no supplier list
   * they could not choose whom to order from.)
   */
  canRaise: has(OWNER_MANAGER)(role),
  /** PATCH a DRAFT (warehouse staff may correct lines; the supplier stays as raised). */
  canEditDraft: has(["MSME_OWNER", "MSME_MANAGER", "WAREHOUSE_STAFF"])(role),
  canChangeSupplier: has(OWNER_MANAGER)(role),
  /** approve / cancel / close. */
  canDecide: has(OWNER_MANAGER)(role),
  canReceive: has(["MSME_OWNER", "MSME_MANAGER", "WAREHOUSE_STAFF"])(role),
  canUseSuppliers: has(OWNER_MANAGER)(role),
  /** GET /v1/ledger/entries/:id — a GRN's postings. */
  canReadLedger: has(["MSME_OWNER", "MSME_MANAGER", "ACCOUNTANT", "VIEWER_AUDITOR"])(role),
});
export type ProcurementPermissions = ReturnType<typeof procurementPermissions>;

// ---- Calls ----

const PO = "/procurement/purchase-orders";
export const fetchPurchaseOrders = (status: PurchaseOrderStatus | "") => getJson<PurchaseOrderList>(withParams(PO, { status: status || undefined }));
export const fetchPurchaseOrder = (id: string) => getJson<PurchaseOrder>(`${PO}/${encodeURIComponent(id)}`);
export const createPurchaseOrder = (body: PurchaseOrderCreateBody) => sendJson<PurchaseOrder>("POST", PO, body);
export const updatePurchaseOrder = (id: string, body: PurchaseOrderUpdateBody) => sendJson<PurchaseOrder>("PATCH", `${PO}/${encodeURIComponent(id)}`, body);
export const decidePurchaseOrder = (id: string, action: "approve" | "cancel" | "close") => sendJson<PurchaseOrder>("POST", `${PO}/${encodeURIComponent(id)}/${action}`);
export const receivePurchaseOrder = (id: string, body: ReceiveBody) => sendJson<GoodsReceipt>("POST", `${PO}/${encodeURIComponent(id)}/receive`, body);
export const fetchGoodsReceipt = (id: string) => getJson<GoodsReceipt>(`/procurement/goods-receipts/${encodeURIComponent(id)}`);
export const fetchJournalEntry = (id: string) => getJson<JournalEntry>(`/ledger/entries/${encodeURIComponent(id)}`);

/** The goods receipts of an order, oldest first — read directly (T-B-PO-GRN-LIST). */
export const fetchOrderGoodsReceipts = (id: string) => getJson<{ data: GoodsReceipt[] }>(`${PO}/${encodeURIComponent(id)}/goods-receipts`);

/** The ids of the goods receipts that received this order, in the order they arrived. */
export async function findGoodsReceiptIds(order: PurchaseOrder): Promise<string[]> {
  return (await fetchOrderGoodsReceipts(order.id)).data.map((grn) => grn.id);
}

// ---- Queries ----

export const procurementKeys = {
  all: ["procurement"] as const,
  list: (status: string) => ["procurement", "list", status] as const,
  order: (id: string) => ["procurement", "order", id] as const,
  receipts: (id: string) => ["procurement", "order-receipts", id] as const,
  grn: (id: string) => ["procurement", "grn", id] as const,
  entry: (id: string) => ["ledger", "entry", id] as const,
};

export function usePurchaseOrders(status: PurchaseOrderStatus | "") {
  return useQuery({ queryKey: procurementKeys.list(status), queryFn: () => fetchPurchaseOrders(status), staleTime: 0 });
}
export function usePurchaseOrder(id: string, initial: PurchaseOrder | undefined) {
  return useQuery({ queryKey: procurementKeys.order(id), queryFn: () => fetchPurchaseOrder(id), placeholderData: initial, staleTime: 0 });
}
export function useOrderReceipts(order: PurchaseOrder | undefined, enabled: boolean) {
  return useQuery({ queryKey: procurementKeys.receipts(order?.id ?? ""), queryFn: () => findGoodsReceiptIds(order as PurchaseOrder), enabled: enabled && order !== undefined, staleTime: 0 });
}
export function useGoodsReceipt(id: string) {
  return useQuery({ queryKey: procurementKeys.grn(id), queryFn: () => fetchGoodsReceipt(id) });
}
export function useJournalEntries(ids: readonly string[], enabled: boolean) {
  return useQueries({ queries: ids.map((id) => ({ queryKey: procurementKeys.entry(id), queryFn: () => fetchJournalEntry(id), enabled })) });
}

/** After a procurement write: the orders, their receipts and every stock read are stale. */
export function useInvalidateProcurement(): () => Promise<void> {
  const client = useQueryClient();
  return useCallback(async () => {
    await client.invalidateQueries({ queryKey: procurementKeys.all });
    await client.invalidateQueries({ queryKey: ["inventory"] });
  }, [client]);
}

// ---- Words and small read helpers ----

export const STATUS_LABEL: Readonly<Record<PurchaseOrderStatus, string>> = {
  DRAFT: "Draft",
  APPROVED: "Approved",
  PARTIALLY_RECEIVED: "Partly received",
  RECEIVED: "Received",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
};
export const STATUSES = Object.keys(STATUS_LABEL) as PurchaseOrderStatus[];

export const poName = (order: Pick<PurchaseOrder, "poNumber">) => `PO ${order.poNumber.toString().padStart(4, "0")}`;
export const grnName = (grn: Pick<GoodsReceipt, "grnNumber">) => `GRN ${grn.grnNumber.toString().padStart(4, "0")}`;

/** What is still to come on a line: ordered − received, in quantity (never money). */
export function outstanding(line: Pick<PurchaseOrderLine, "orderedQty" | "receivedQty">): string {
  if (!isQuantity(line.orderedQty) || !isQuantity(line.receivedQty)) return "0";
  const left = toMilli(line.orderedQty) - toMilli(line.receivedQty);
  return fromMilli(left > 0n ? left : 0n);
}

/** Which lifecycle steps the order's status allows (the server is the guard; this hides dead buttons). */
export const STEPS: Readonly<Record<PurchaseOrderStatus, { edit: boolean; approve: boolean; cancel: boolean; receive: boolean; close: boolean }>> = {
  DRAFT: { edit: true, approve: true, cancel: true, receive: false, close: false },
  APPROVED: { edit: false, approve: false, cancel: true, receive: true, close: false },
  PARTIALLY_RECEIVED: { edit: false, approve: false, cancel: false, receive: true, close: true },
  RECEIVED: { edit: false, approve: false, cancel: false, receive: false, close: true },
  CLOSED: { edit: false, approve: false, cancel: false, receive: false, close: false },
  CANCELLED: { edit: false, approve: false, cancel: false, receive: false, close: false },
};
