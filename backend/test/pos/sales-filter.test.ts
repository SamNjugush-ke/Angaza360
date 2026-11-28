// ===========================================================================
// THE POS SALES LIST'S LOOKUP FILTERS (Task T-B-SALES-FILTER, lookup), through the REAL app.
//
// GET /v1/pos/sales takes q (case-insensitive contains on saleNumber, % and _ literal), status
// (COMPLETED | VOIDED) and customerId, alone or with the business-day from/to and shiftId;
// pagination.total counts the FILTERED set; the order stays business recency with saleNumber and
// id as tiebreakers, so pages never overlap or drop a row at a boundary. Read roles and tenant
// isolation are unchanged.
// ===========================================================================

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformDb } from "../../src/db/platform";
import type { UserRole } from "../../src/generated/platform/enums";
import { businessDateOf } from "../../src/lib/business-time";
import { buildServer } from "../../src/server";
import { listSales, recordSale, voidSale, type ListSalesFilters } from "../../src/services/sales";
import { openShift } from "../../src/services/shifts";
import { bearer, createStaffUser, signIn, type SignedIn, type StaffUser } from "../identity/staff-fixture";
import { freshIp } from "../security/http-app";
import { dropTenant, provisionFixture, tenantDb, tenantIdOf } from "../setup/tenant";
import { actorId, uniq } from "../support/fixtures";

const TENANT = "qa-sales-filter";
const OTHER = "qa-sales-filter-b";
const DAY_MS = 86_400_000;

let app: FastifyInstance;
const users: StaffUser[] = [];
const signedIn = new Map<UserRole, SignedIn>();
let owner: SignedIn;
let wanjiru = "";
let kiptoo = "";
let otherCustomer = "";
let shiftA = "";
/** Every sale in TENANT, by label. */
const sale = new Map<string, { id: string; saleNumber: string }>();
const today = businessDateOf(new Date());
const yesterday = businessDateOf(new Date(Date.now() - DAY_MS));
const iso = (d: Date) => d.toISOString().slice(0, 10);

async function seedTenant(subdomain: string) {
  const db = tenantDb(subdomain);
  const service = await db.product.create({ data: { sku: uniq("SVC"), name: uniq("Service"), costPrice: 0n, price: 10000n, kind: "SERVICE" } });
  const cashier = actorId();
  const shift = await openShift(db, cashier, 0n);
  const ring = (customerId?: string) =>
    recordSale(db, {
      shiftId: shift.id,
      createdBy: cashier,
      ...(customerId ? { customerId } : {}),
      lines: [{ productId: service.id, quantity: "1" }],
      tenders: [{ tenderType: "CASH", amount: "100.00" }],
    });
  return { db, shift, ring };
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  for (const subdomain of [TENANT, OTHER]) {
    await dropTenant(subdomain);
    await provisionFixture(subdomain, subdomain === TENANT ? "QA Sales Filter" : "QA Sales Filter B");
  }

  const a = await seedTenant(TENANT);
  shiftA = a.shift.id;
  wanjiru = (await a.db.customer.create({ data: { name: "Wanjiru Builders" } })).id;
  kiptoo = (await a.db.customer.create({ data: { name: "Kiptoo Hardware" } })).id;
  // S1..S7 in one shift: S1–S3 Wanjiru, S4–S5 Kiptoo, S6–S7 walk-in; S2, S4 and S7 voided.
  const plan: Array<[string, string | undefined]> = [
    ["S1", wanjiru],
    ["S2", wanjiru],
    ["S3", wanjiru],
    ["S4", kiptoo],
    ["S5", kiptoo],
    ["S6", undefined],
    ["S7", undefined],
  ];
  for (const [label, customerId] of plan) {
    const rung = await a.ring(customerId);
    sale.set(label, { id: rung.id, saleNumber: rung.saleNumber });
  }
  for (const label of ["S2", "S4", "S7"]) await voidSale(a.db, sale.get(label)?.id ?? "", "Filter test", actorId());

  // The other business rings sales with the SAME sale numbers, for a customer of its own.
  const b = await seedTenant(OTHER);
  otherCustomer = (await b.db.customer.create({ data: { name: "Wanjiru Builders (other business)" } })).id;
  await b.ring(otherCustomer);
  await b.ring();

  const tenantId = await tenantIdOf(TENANT);
  for (const role of ["MSME_OWNER", "MSME_MANAGER", "CASHIER", "ACCOUNTANT", "VIEWER_AUDITOR", "WAREHOUSE_STAFF", "HR_OFFICER"] as const) {
    const user = await createStaffUser(role, tenantId);
    users.push(user);
    signedIn.set(role, await signIn(app, user));
  }
  owner = signedIn.get("MSME_OWNER") as SignedIn;
});

afterAll(async () => {
  await platformDb.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  for (const subdomain of [TENANT, OTHER]) await dropTenant(subdomain);
  await app.close();
});

const labelOf = (saleNumber: string) => [...sale.entries()].find(([, s]) => s.saleNumber === saleNumber)?.[0] ?? `?${saleNumber}`;

interface ListBody {
  data: Array<{ id: string; saleNumber: string; status: string; customerId: string | null; total: string }>;
  pagination: { take: number; skip: number; total: number };
}

function get(query: string, who: SignedIn = owner) {
  return app.inject({ method: "GET", url: `/v1/pos/sales${query}`, remoteAddress: freshIp(), headers: bearer(who.token) });
}

/** The labels a query returns (sorted) and its filtered total. */
async function labels(query: string, who: SignedIn = owner): Promise<{ labels: string[]; total: number }> {
  const response = await get(query, who);
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json<ListBody>();
  return { labels: body.data.map((row) => labelOf(row.saleNumber)).sort(), total: body.pagination.total };
}

const service = (filters: Omit<ListSalesFilters, "take" | "skip">) => listSales(tenantDb(TENANT), { take: 50, skip: 0, ...filters });

describe("q — the sale number, case-insensitive, literal", () => {
  it("finds a sale by part of its number, in any case", async () => {
    const s3 = sale.get("S3")?.saleNumber ?? "";
    const tail = s3.slice(-6); // e.g. "000003"
    expect(await labels(`?q=${tail}`)).toEqual({ labels: ["S3"], total: 1 });
    expect(await labels(`?q=${encodeURIComponent(s3.toLowerCase())}`)).toEqual({ labels: ["S3"], total: 1 });
    expect((await labels("?q=sale-")).total).toBe(7);
  });

  it("treats % and _ as themselves, never as wildcards", async () => {
    // As wildcards, "_" and "%" would match every sale and "SALE_" would match "SALE-…".
    expect(await labels(`?q=${encodeURIComponent("_")}`)).toEqual({ labels: [], total: 0 });
    expect(await labels(`?q=${encodeURIComponent("%")}`)).toEqual({ labels: [], total: 0 });
    expect(await labels(`?q=${encodeURIComponent("SALE_")}`)).toEqual({ labels: [], total: 0 });
    expect((await service({ q: "S%E" })).pagination.total).toBe(0);
  });

  it("a blank q filters nothing", async () => {
    expect((await labels("?q=%20%20")).total).toBe(7);
  });
});

describe("status — completed vs voided", () => {
  it("splits the shift's sales exactly in two", async () => {
    expect(await labels("?status=COMPLETED")).toEqual({ labels: ["S1", "S3", "S5", "S6"], total: 4 });
    expect(await labels("?status=VOIDED")).toEqual({ labels: ["S2", "S4", "S7"], total: 3 });
  });

  it("refuses a status that is not one", async () => {
    expect((await get("?status=PENDING")).statusCode).toBe(400);
  });
});

describe("customerId — one customer's sales", () => {
  it("scopes to that customer only", async () => {
    expect(await labels(`?customerId=${wanjiru}`)).toEqual({ labels: ["S1", "S2", "S3"], total: 3 });
    expect(await labels(`?customerId=${kiptoo}`)).toEqual({ labels: ["S4", "S5"], total: 2 });
  });

  it("combines with status and q", async () => {
    expect(await labels(`?customerId=${wanjiru}&status=COMPLETED`)).toEqual({ labels: ["S1", "S3"], total: 2 });
    const s5 = sale.get("S5")?.saleNumber.slice(-6) ?? "";
    expect(await labels(`?customerId=${kiptoo}&status=COMPLETED&q=${s5}`)).toEqual({ labels: ["S5"], total: 1 });
    expect(await labels(`?customerId=${wanjiru}&q=${s5}`)).toEqual({ labels: [], total: 0 });
  });
});

describe("each filter with the business-day date range", () => {
  it("today keeps the filtered set; yesterday empties it", async () => {
    const on = (d: Date) => `from=${iso(d)}&to=${iso(d)}`;
    expect(await labels(`?${on(today)}&status=VOIDED`)).toEqual({ labels: ["S2", "S4", "S7"], total: 3 });
    expect(await labels(`?${on(today)}&customerId=${kiptoo}`)).toEqual({ labels: ["S4", "S5"], total: 2 });
    const s1 = sale.get("S1")?.saleNumber.slice(-6) ?? "";
    expect(await labels(`?${on(today)}&q=${s1}`)).toEqual({ labels: ["S1"], total: 1 });
    expect(await labels(`?${on(yesterday)}&status=VOIDED`)).toEqual({ labels: [], total: 0 });
    expect(await labels(`?${on(yesterday)}&customerId=${kiptoo}`)).toEqual({ labels: [], total: 0 });
    expect(await labels(`?${on(yesterday)}&q=${s1}`)).toEqual({ labels: [], total: 0 });
  });

  it("and with the shift", async () => {
    expect(await labels(`?shiftId=${shiftA}&status=COMPLETED&customerId=${wanjiru}`)).toEqual({ labels: ["S1", "S3"], total: 2 });
  });
});

describe("stable pages under a filter", () => {
  it("pages of a filtered list never overlap or drop a row at a boundary", async () => {
    for (const query of ["", "&status=COMPLETED", `&customerId=${wanjiru}`, "&q=sale"]) {
      const full = (await get(`?take=50${query}`)).json<ListBody>();
      const ids: string[] = [];
      for (let skip = 0; skip < full.data.length; skip += 2) {
        const page = (await get(`?take=2&skip=${skip.toString()}${query}`)).json<ListBody>();
        expect(page.pagination).toEqual({ take: 2, skip, total: full.pagination.total });
        ids.push(...page.data.map((row) => row.id));
      }
      expect(ids).toEqual(full.data.map((row) => row.id));
      expect(new Set(ids).size).toBe(full.pagination.total);
    }
  });

  it("the filters leave the business-recency order alone: newest sale first", async () => {
    const { data } = await service({});
    const numbers = data.map((row) => row.saleNumber);
    expect(numbers).toEqual([...numbers].sort().reverse());
  });
});

describe("tenant isolation", () => {
  it("another business's matching sale numbers and customer never appear", async () => {
    // The other business rang SALE-…-000001 and -000002 as well.
    const s1 = sale.get("S1") ?? { id: "", saleNumber: "" };
    const response = (await get(`?q=${s1.saleNumber}`)).json<ListBody>();
    expect(response.data.map((row) => row.id)).toEqual([s1.id]);
    expect(await labels(`?customerId=${otherCustomer}`)).toEqual({ labels: [], total: 0 });
    expect((await labels("")).total).toBe(7);
  });
});

describe("RBAC — read roles unchanged", () => {
  it("owner, manager, cashier, accountant and auditor read; warehouse staff and HR are refused", async () => {
    for (const role of ["MSME_OWNER", "MSME_MANAGER", "CASHIER", "ACCOUNTANT", "VIEWER_AUDITOR"] as const) {
      const response = await get("?status=VOIDED", signedIn.get(role));
      expect(response.statusCode, role).toBe(200);
      expect(response.json<ListBody>().pagination.total, role).toBe(3);
    }
    for (const role of ["WAREHOUSE_STAFF", "HR_OFFICER"] as const) {
      expect((await get("?status=VOIDED", signedIn.get(role))).statusCode, role).toBe(403);
    }
    const anonymous = await app.inject({ method: "GET", url: "/v1/pos/sales?status=VOIDED", remoteAddress: freshIp() });
    expect(anonymous.statusCode).toBe(401);
  });
});
