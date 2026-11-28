// ===========================================================================
// THE CATALOG LIST'S FILTERS AND STABLE PAGES (Task T-B-PRODUCTS-SEARCH), through the REAL app.
//
// GET /v1/products takes q (name / sku / barcode, case-insensitive, % and _ literal),
// category (exact, case-insensitive), active and kind; pagination.total counts the FILTERED
// set; pages are ordered newest first then by id, so same-instant rows never overlap or drop
// across a page boundary. GET /v1/products/categories lists the distinct categories. Read
// roles are unchanged and the tenant is the session's.
// ===========================================================================

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformDb } from "../../src/db/platform";
import type { UserRole } from "../../src/generated/platform/enums";
import { buildServer } from "../../src/server";
import { bearer, createStaffUser, signIn, type SignedIn, type StaffUser } from "../identity/staff-fixture";
import { freshIp } from "../security/http-app";
import { dropTenant, provisionFixture, tenantDb, tenantIdOf } from "../setup/tenant";

const TENANT = "qa-search";
const OTHER = "qa-search-b";
const SAME_INSTANT = new Date("2026-05-01T08:00:00.000Z");

let app: FastifyInstance;
let owner: SignedIn;
const users: StaffUser[] = [];
const signedIn = new Map<UserRole, SignedIn>();

interface ListBody {
  data: Array<{ id: string; sku: string; name: string; category: string | null; isActive: boolean; kind: string }>;
  pagination: { take: number; skip: number; total: number };
}

function list(query: string, who: SignedIn = owner) {
  return app.inject({ method: "GET", url: `/v1/products${query}`, remoteAddress: freshIp(), headers: bearer(who.token) });
}
async function skus(query: string): Promise<{ skus: string[]; total: number }> {
  const response = await list(query);
  expect(response.statusCode).toBe(200);
  const body = response.json<ListBody>();
  return { skus: body.data.map((row) => row.sku).sort(), total: body.pagination.total };
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  for (const subdomain of [TENANT, OTHER]) {
    await dropTenant(subdomain);
    await provisionFixture(subdomain, subdomain === TENANT ? "QA Search" : "QA Search B");
  }
  const db = tenantDb(TENANT);
  const product = (data: { sku: string; name: string; category?: string; barcode?: string; kind?: "GOOD" | "SERVICE"; isActive?: boolean; createdAt?: Date }) =>
    db.product.create({ data: { costPrice: 100n, price: 200n, ...data } });
  await product({ sku: "PNT-RED", name: "Red Gloss Paint", category: "Paint", barcode: "600111" });
  await product({ sku: "PNT-BLU", name: "Blue Matt Paint", category: "paint", barcode: "600222" });
  await product({ sku: "PNT-SET", name: "Paint Brush Set", category: "Paints" });
  await product({ sku: "DISC-50", name: "50% Off Bundle", category: "Promotions" });
  await product({ sku: "DISC-5O", name: "50 Off Bundle", category: "Promotions" });
  await product({ sku: "A_1", name: "Anchor", category: "  " });
  await product({ sku: "AB1", name: "Anchor bolt" });
  await product({ sku: "SVC-DEL", name: "Delivery", kind: "SERVICE", category: "Services" });
  await product({ sku: "OLD-PNT", name: "Retired Paint", category: "Paint", isActive: false });
  // Seven products created in the SAME instant, to test the page boundary.
  for (let i = 1; i <= 7; i += 1) await product({ sku: `TIE-${i.toString()}`, name: `Tie ${i.toString()}`, category: "Ties", createdAt: SAME_INSTANT });
  await tenantDb(OTHER).product.create({ data: { sku: "PNT-RED", name: "Red Gloss Paint (other business)", category: "Other Paint", costPrice: 1n, price: 2n } });

  const tenantId = await tenantIdOf(TENANT);
  for (const role of ["MSME_OWNER", "MSME_MANAGER", "WAREHOUSE_STAFF", "CASHIER", "VIEWER_AUDITOR", "ACCOUNTANT"] as const) {
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

describe("each filter alone", () => {
  it("q matches name, sku or barcode, case-insensitively, and total counts the matches", async () => {
    expect(await skus("?q=gloss")).toEqual({ skus: ["PNT-RED"], total: 1 });
    expect(await skus("?q=pnt-b")).toEqual({ skus: ["PNT-BLU"], total: 1 });
    expect(await skus("?q=600222")).toEqual({ skus: ["PNT-BLU"], total: 1 });
    expect(await skus("?q=PAINT")).toEqual({ skus: ["OLD-PNT", "PNT-BLU", "PNT-RED", "PNT-SET"], total: 4 });
  });

  it("treats % and _ in q as literal characters", async () => {
    expect(await skus("?q=50%25")).toEqual({ skus: ["DISC-50"], total: 1 });
    expect(await skus("?q=A_1")).toEqual({ skus: ["A_1"], total: 1 });
    expect(await skus("?q=_")).toEqual({ skus: ["A_1"], total: 1 });
    expect(await skus("?q=%25")).toEqual({ skus: ["DISC-50"], total: 1 });
  });

  it("category is an exact, case-insensitive match", async () => {
    expect(await skus("?category=PAINT")).toEqual({ skus: ["OLD-PNT", "PNT-BLU", "PNT-RED"], total: 3 });
    expect(await skus("?category=Paints")).toEqual({ skus: ["PNT-SET"], total: 1 });
  });

  it("active filters by status; omitted lists both", async () => {
    expect(await skus("?active=false")).toEqual({ skus: ["OLD-PNT"], total: 1 });
    expect((await skus("?active=true")).total).toBe(15);
    expect((await skus("")).total).toBe(16);
    expect((await list("?active=maybe")).statusCode).toBe(400);
  });

  it("kind filters goods and services", async () => {
    expect(await skus("?kind=SERVICE")).toEqual({ skus: ["SVC-DEL"], total: 1 });
    expect((await skus("?kind=GOOD")).total).toBe(15);
    expect((await list("?kind=BUNDLE")).statusCode).toBe(400);
  });
});

describe("filters combined", () => {
  it("narrows by every filter at once, and total is the filtered count", async () => {
    expect(await skus("?q=paint&category=paint&active=true&kind=GOOD")).toEqual({ skus: ["PNT-BLU", "PNT-RED"], total: 2 });
    expect(await skus("?q=paint&category=paint&active=true&kind=SERVICE")).toEqual({ skus: [], total: 0 });
    const page = await list("?q=paint&take=1");
    expect(page.json<ListBody>().pagination).toEqual({ take: 1, skip: 0, total: 4 });
  });
});

describe("stable pages", () => {
  it("never overlaps or drops a row across page boundaries, even for same-instant rows", async () => {
    const seen: string[] = [];
    for (let skip = 0; skip < 7; skip += 3) {
      const body = (await list(`?category=Ties&take=3&skip=${skip.toString()}`)).json<ListBody>();
      expect(body.pagination.total).toBe(7);
      seen.push(...body.data.map((row) => row.id));
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    // The order is total: newest first, then id descending.
    expect(seen).toEqual([...seen].sort().reverse());
    // And it is the same on every request.
    const again = (await list("?category=Ties&take=7")).json<ListBody>().data.map((row) => row.id);
    expect(again).toEqual(seen);
  });
});

describe("categories", () => {
  it("lists distinct non-blank categories, sorted, case variants collapsed", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/products/categories", remoteAddress: freshIp(), headers: bearer(owner.token) });
    expect(response.statusCode).toBe(200);
    const { data } = response.json<{ data: string[] }>();
    expect(data).toHaveLength(5);
    expect(data.map((c) => c.toLowerCase())).toEqual(["paint", "paints", "promotions", "services", "ties"]);
  });
});

describe("isolation and RBAC", () => {
  it("never returns another business's products or categories", async () => {
    expect(await skus("?q=other business")).toEqual({ skus: [], total: 0 });
    expect(await skus("?category=Other Paint")).toEqual({ skus: [], total: 0 });
    const categories = (await app.inject({ method: "GET", url: "/v1/products/categories", remoteAddress: freshIp(), headers: bearer(owner.token) })).json<{ data: string[] }>().data;
    expect(categories).not.toContain("Other Paint");
  });

  it("keeps the read roles exactly as they were: ACCOUNTANT refused, anonymous 401", async () => {
    for (const role of ["MSME_OWNER", "MSME_MANAGER", "WAREHOUSE_STAFF", "CASHIER", "VIEWER_AUDITOR"] as const) {
      const who = signedIn.get(role) as SignedIn;
      expect([role, (await list("?q=paint", who)).statusCode]).toEqual([role, 200]);
      const categories = await app.inject({ method: "GET", url: "/v1/products/categories", remoteAddress: freshIp(), headers: bearer(who.token) });
      expect([role, categories.statusCode]).toEqual([role, 200]);
    }
    const accountant = signedIn.get("ACCOUNTANT") as SignedIn;
    expect((await list("", accountant)).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/v1/products/categories", remoteAddress: freshIp(), headers: bearer(accountant.token) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/v1/products", remoteAddress: freshIp() })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/products/categories", remoteAddress: freshIp() })).statusCode).toBe(401);
  });

  it("leaves the write guards as they were (cashier and auditor cannot create)", async () => {
    for (const role of ["CASHIER", "VIEWER_AUDITOR"] as const) {
      const who = signedIn.get(role) as SignedIn;
      const created = await app.inject({
        method: "POST",
        url: "/v1/products",
        remoteAddress: freshIp(),
        headers: bearer(who.token),
        payload: { sku: `RBAC-${role}`, name: "Nope", costPrice: "1.00", price: "2.00" },
      });
      expect([role, created.statusCode]).toEqual([role, 403]);
    }
  });
});
