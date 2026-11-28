import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { paths } from "@/lib/api/schema";
import { getJson, sendDelete, sendJson, withParams } from "@/lib/api/request";
import type { Role } from "@/lib/auth/landing";

// CASHIER TILLS AND STOCK REQUESTS (M4.5 Wave 3). A cashier sells from the ONE location an owner or
// manager assigned them (the backend enforces it); from the till they see what is running low
// there and ask for more. The owner / manager worklist decides each request — approve as asked,
// approve a different quantity, or decline — and can send any other stock straight to a location.
// Quantities are decimal strings and are NOT money; nothing here carries a price.

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Body<T> = T extends { requestBody?: { content: { "application/json": infer B } } } ? B : never;

export type MyLocation = Json<paths["/v1/pos/my-location"]["get"]["responses"][200]>;
export type AssignedLocation = NonNullable<MyLocation["location"]>;
export type LowStockSlice = MyLocation["lowStock"][number];
export type AllocationRequest = MyLocation["myRequests"][number];
export type AllocationStatus = AllocationRequest["status"];
export type CashierAssignmentList = Json<paths["/v1/pos/cashier-assignments"]["get"]["responses"][200]>;
export type CashierAssignment = CashierAssignmentList["data"][number];
export type RequestList = Json<paths["/v1/allocations/requests"]["get"]["responses"][200]>;
export type RequestBody = Body<paths["/v1/allocations/requests"]["post"]>;
export type DecideBody = Body<paths["/v1/allocations/requests/{id}/decide"]["post"]>;
export type AllocateBody = Body<paths["/v1/allocations/"]["post"]>;
export type AllocateResult = Json<paths["/v1/allocations/"]["post"]["responses"][201]>;

const has = (roles: readonly Role[]) => (role: Role) => roles.includes(role);

/** The API's guards, mirrored so no role is offered a refusal. */
export const allocationPermissions = (role: Role) => ({
  /** The cashier is held to one location by the backend. */
  restricted: role === "CASHIER",
  /** PUT / DELETE /v1/pos/cashier-assignments, POST /requests/{id}/decide. */
  canManageTills: has(["MSME_OWNER", "MSME_MANAGER"])(role),
  canDecide: has(["MSME_OWNER", "MSME_MANAGER"])(role),
  /** POST /v1/allocations (a direct send, no request). */
  canSendStock: has(["MSME_OWNER", "MSME_MANAGER", "WAREHOUSE_STAFF"])(role),
  /** GET /v1/allocations/requests. */
  canReadRequests: has(["MSME_OWNER", "MSME_MANAGER", "WAREHOUSE_STAFF", "CASHIER", "ACCOUNTANT", "VIEWER_AUDITOR"])(role),
});
export type AllocationPermissions = ReturnType<typeof allocationPermissions>;

export const STATUS_LABEL: Readonly<Record<AllocationStatus, string>> = {
  PENDING: "Waiting for a decision",
  APPROVED: "Approved — stock sent",
  DECLINED: "Declined",
  CANCELLED: "Withdrawn",
};

// ---- Calls ----

export const fetchMyLocation = () => getJson<MyLocation>("/pos/my-location");
export const fetchCashierAssignments = () => getJson<CashierAssignmentList>("/pos/cashier-assignments");
export const assignCashier = (userId: string, locationId: string) =>
  sendJson<CashierAssignment>("PUT", `/pos/cashier-assignments/${encodeURIComponent(userId)}`, { locationId });
export const unassignCashier = (userId: string) => sendDelete(`/pos/cashier-assignments/${encodeURIComponent(userId)}`);

export interface RequestFilter {
  status: AllocationStatus | "";
  locationId: string;
  productId: string;
}
export const fetchRequests = (filter: RequestFilter) =>
  getJson<RequestList>(
    withParams("/allocations/requests", {
      status: filter.status === "" ? undefined : filter.status,
      locationId: filter.locationId === "" ? undefined : filter.locationId,
      productId: filter.productId === "" ? undefined : filter.productId,
    }),
  );
export const requestStock = (body: RequestBody) => sendJson<AllocationRequest>("POST", "/allocations/requests", body);
export const cancelRequest = (id: string) => sendJson<AllocationRequest>("POST", `/allocations/requests/${encodeURIComponent(id)}/cancel`);
export const decideRequest = (id: string, body: DecideBody) => sendJson<AllocationRequest>("POST", `/allocations/requests/${encodeURIComponent(id)}/decide`, body);
export const sendStock = (body: AllocateBody) => sendJson<AllocateResult>("POST", "/allocations", body);

// ---- Queries ----

export const allocationKeys = {
  all: ["allocations"] as const,
  myLocation: () => ["allocations", "my-location"] as const,
  tills: () => ["allocations", "tills"] as const,
  requests: (filter: RequestFilter) => ["allocations", "requests", filter] as const,
};

export function useMyLocation(enabled = true) {
  return useQuery({ queryKey: allocationKeys.myLocation(), queryFn: fetchMyLocation, enabled, staleTime: 0 });
}

export function useCashierAssignments() {
  return useQuery({ queryKey: allocationKeys.tills(), queryFn: fetchCashierAssignments });
}

export function useRequests(filter: RequestFilter) {
  return useQuery({ queryKey: allocationKeys.requests(filter), queryFn: () => fetchRequests(filter), staleTime: 0 });
}

/** After any change: the requests, the till's view and the stock (an approval moved it). */
export function useInvalidateAllocations() {
  const client = useQueryClient();
  return useCallback(async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: allocationKeys.all }),
      client.invalidateQueries({ queryKey: ["inventory"] }),
      client.invalidateQueries({ queryKey: ["pos"] }),
    ]);
  }, [client]);
}

/** "5.000" → "5" — a quantity as a person types it. Text only, no arithmetic. */
export function plainQuantity(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}
