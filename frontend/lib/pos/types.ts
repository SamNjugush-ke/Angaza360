import type { paths } from "@/lib/api/schema";

// The till's shapes, from the generated API types (lib/api/schema.d.ts), so they cannot drift from
// the backend. Money in a RESPONSE is a string of cents; money in a REQUEST is a decimal string in
// shillings ("1500.00") — the API's rule, kept by the money utils (centsToAmount).

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Body<T> = T extends { requestBody?: { content: { "application/json": infer B } } } ? B : never;

export type ShiftSummary = Json<paths["/v1/pos/shifts/current"]["get"]["responses"][200]>;
export type Quote = Json<paths["/v1/pos/sales/quote"]["post"]["responses"][200]>;
export type QuoteLine = Quote["lines"][number];
export type QuoteBody = Body<paths["/v1/pos/sales/quote"]["post"]>;
export type Sale = Json<paths["/v1/pos/sales"]["post"]["responses"][201]>;
export type SaleBody = Body<paths["/v1/pos/sales"]["post"]>;
export type SaleTenderBody = SaleBody["tenders"][number];
export type Receipt = Json<paths["/v1/pos/sales/{id}/receipt"]["get"]["responses"][200]>;
export type CustomerList = Json<paths["/v1/customers/"]["get"]["responses"][200]>;
export type Customer = CustomerList["data"][number];
export type CustomerCreateBody = Body<paths["/v1/customers/"]["post"]>;
export type StkPushBody = Body<paths["/v1/pos/mpesa/stk-push"]["post"]>;
export type StkPush = Json<paths["/v1/pos/mpesa/stk-push"]["post"]["responses"][201]>;
export type StkStatus = Json<paths["/v1/pos/mpesa/{checkoutRequestId}"]["get"]["responses"][200]>;
export type SaleRecord = Json<paths["/v1/pos/sales/{id}"]["get"]["responses"][200]>;
export type SaleList = Json<paths["/v1/pos/sales"]["get"]["responses"][200]>;
export type VoidResult = Json<paths["/v1/pos/sales/{id}/void"]["post"]["responses"][200]>;

/** Every tender the till takes. */
export type TillTenderType = SaleTenderBody["tenderType"];
/** How an M-Pesa payment reached the business, as the sale records it. */
export type MpesaChannel = NonNullable<SaleTenderBody["mpesaChannel"]>;

export const TENDER_LABEL: Readonly<Record<SaleTenderBody["tenderType"], string>> = {
  CASH: "Cash",
  MPESA: "M-Pesa",
  BANK_TRANSFER: "Bank transfer",
  CREDIT: "Credit",
};
