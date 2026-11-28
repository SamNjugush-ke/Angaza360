// Type-level assertions over the generated schema. This file emits nothing; `tsc` (and the Next
// build) fail if the generated API types stop matching what the frontend relies on — a known
// endpoint vanishing, or a money field arriving as anything but a string of cents.

import type { components, paths } from "./schema";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

type DashboardOk = paths["/v1/dashboard/"]["get"]["responses"][200]["content"]["application/json"];
type TrendBucket = paths["/v1/dashboard/trend"]["get"]["responses"][200]["content"]["application/json"][number];
type TopProduct = paths["/v1/reports/top-products"]["get"]["responses"][200]["content"]["application/json"][number];

export type SchemaAssertions = [
  // The endpoint exists.
  Expect<Equal<"/v1/dashboard/" extends keyof paths ? true : false, true>>,
  // Money is a string of cents — never a number.
  Expect<Equal<DashboardOk["revenue"], string>>,
  Expect<Equal<DashboardOk["netProfit"], string>>,
  Expect<Equal<DashboardOk["cashPosition"]["total"], string>>,
  Expect<Equal<DashboardOk["cashPosition"]["accounts"][number]["amount"], string>>,
  Expect<Equal<DashboardOk["receivables"], string>>,
  Expect<Equal<DashboardOk["payables"], string>>,
  // The dashboard trend (T-F-DASH-1): money as strings, the month-to-date flag a boolean.
  Expect<Equal<"/v1/dashboard/trend" extends keyof paths ? true : false, true>>,
  Expect<Equal<TrendBucket["revenue"], string>>,
  Expect<Equal<TrendBucket["costOfSales"], string>>,
  Expect<Equal<TrendBucket["grossProfit"], string>>,
  Expect<Equal<TrendBucket["operatingExpenses"], string>>,
  Expect<Equal<TrendBucket["netProfit"], string>>,
  Expect<Equal<TrendBucket["partial"], boolean>>,
  Expect<Equal<TrendBucket["month"], string>>,
  // Top-selling products (T-F-DASH-2): revenue and quantity as strings.
  Expect<Equal<"/v1/reports/top-products" extends keyof paths ? true : false, true>>,
  Expect<Equal<TopProduct["revenue"], string>>,
  Expect<Equal<TopProduct["quantity"], string>>,
  Expect<Equal<TopProduct["kind"], "GOOD" | "SERVICE">>,
  // The one error envelope.
  Expect<Equal<components["schemas"]["Error"], { statusCode: number; error: string; message: string }>>,
];
