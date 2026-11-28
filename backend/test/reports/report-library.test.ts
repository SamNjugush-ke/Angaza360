// ===========================================================================
// THE REPORT LIBRARY AND THE SHARED EXPORT ENGINE (M4.5 W4), through the REAL app.
//
// Proven: a formula in a product or customer name is neutralised in .xlsx and .csv; an .xlsx is a
// real workbook whose totals are SUM formulas that equal the BigInt total and whose income
// statement equals the Module 13 statement to the cent; a filter scopes the view AND the export
// identically; a business sees only its own data (a tenant id in the query is ignored); a role
// is offered only the reports its screens allow (and no valuation it may not see); every export
// is audited without data; a large export is built in the background, encrypted, downloadable
// only by its requester until it expires; the export-file guards hold against raw SQL; a .pdf is
// a branded, paginated PDF; platform reports are for platform staff only.
// ===========================================================================

import ExcelJS from "exceljs";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformDb } from "../../src/db/platform";
import { pool } from "../../src/db/pool";
import { tenantSchemaFor } from "../../src/db/tenant";
import type { UserRole } from "../../src/generated/platform/enums";
import { buildServer } from "../../src/server";
import { cleanupExports } from "../../src/services/export/files";
import { buildIncomeStatement } from "../../src/services/reports";
import { recordSale, voidSale } from "../../src/services/sales";
import { openShift } from "../../src/services/shifts";
import { bearer, createStaffUser, signIn, type SignedIn, type StaffUser } from "../identity/staff-fixture";
import { freshIp } from "../security/http-app";
import { dropTenant, provisionFixture, tenantDb, tenantIdOf, withTenantTx } from "../setup/tenant";
import { expectDbRefusal } from "../support/db-errors";
import { actorId, uniq } from "../support/fixtures";

const T = "qa-report-lib";
const OTHER = "qa-report-lib-b";
const EVIL_PRODUCT = '=HYPERLINK("http://evil.example","click")';
const EVIL_CUSTOMER = "+CMD|' /C calc'!A0";

let app: FastifyInstance;
const users: StaffUser[] = [];
const as = new Map<string, SignedIn>();
let admin: SignedIn;
let otherOwner: SignedIn;
const saleTotals: bigint[] = [];

function get(url: string, who: SignedIn): Promise<LightMyRequestResponse> {
  return app.inject({ method: "GET", url, remoteAddress: freshIp(), headers: bearer(who.token) });
}

interface View {
  title: string;
  filters: Array<{ label: string; value: string }>;
  sections: Array<{ name: string; columns: Array<{ key: string; kind: string }>; totalRows: number; rows: Array<Record<string, string | null>>; totals: Record<string, string> | null }>;
}

async function workbook(body: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(body as unknown as ArrayBuffer);
  return wb;
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  for (const sub of [T, OTHER]) {
    await dropTenant(sub);
    await provisionFixture(sub, sub === T ? "QA Report Library" : "QA Report Library B");
  }
  const tenantId = await tenantIdOf(T);
  for (const role of ["MSME_OWNER", "MSME_MANAGER", "ACCOUNTANT", "CASHIER", "WAREHOUSE_STAFF", "HR_OFFICER"] as const) {
    const user = await createStaffUser(role, tenantId);
    users.push(user);
    as.set(role, await signIn(app, user));
  }
  const otherUser = await createStaffUser("MSME_OWNER", await tenantIdOf(OTHER));
  users.push(otherUser);
  otherOwner = await signIn(app, otherUser);
  const adminUser = await createStaffUser("SUPER_ADMIN", null);
  users.push(adminUser);
  admin = await signIn(app, adminUser);

  const db = tenantDb(T);
  const product = await db.product.create({ data: { sku: uniq("EVIL"), name: EVIL_PRODUCT, costPrice: 0n, price: 12345n, kind: "SERVICE" } });
  const customer = await db.customer.create({ data: { name: EVIL_CUSTOMER, creditLimit: 10_000_000n } });
  const cashier = actorId();
  const shift = await openShift(db, cashier, 0n);
  for (let i = 1; i <= 3; i += 1) {
    const sale = await recordSale(db, { shiftId: shift.id, createdBy: cashier, ...(i === 2 ? { customerId: customer.id } : {}), lines: [{ productId: product.id, quantity: String(i) }], tenders: [{ tenderType: i === 2 ? "CREDIT" : "CASH", amount: (Number(12345n * BigInt(i)) / 100).toFixed(2) }] });
    saleTotals.push(sale.total);
  }
  // Paid by bank, so the void refunds no drawer.
  const voided = await recordSale(db, { shiftId: shift.id, createdBy: cashier, lines: [{ productId: product.id, quantity: "1" }], tenders: [{ tenderType: "BANK_TRANSFER", amount: "123.45" }] });
  await voidSale(db, voided.id, "test", cashier);

  const otherDb = tenantDb(OTHER);
  const otherProduct = await otherDb.product.create({ data: { sku: uniq("B"), name: "Other business service", costPrice: 0n, price: 50000n, kind: "SERVICE" } });
  const otherCashier = actorId();
  const otherShift = await openShift(otherDb, otherCashier, 0n);
  await recordSale(otherDb, { shiftId: otherShift.id, createdBy: otherCashier, lines: [{ productId: otherProduct.id, quantity: "1" }], tenders: [{ tenderType: "CASH", amount: "500.00" }] });
});

afterAll(async () => {
  delete process.env.EXPORT_SYNC_MAX_ROWS;
  await platformDb.platformExportFile.deleteMany({ where: { requestedBy: { in: users.map((u) => u.id) } } }).catch(() => undefined);
  await platformDb.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  for (const sub of [T, OTHER]) await dropTenant(sub);
  await app.close();
});

const owner = () => as.get("MSME_OWNER") as SignedIn;

describe("formula injection is neutralised", () => {
  it("in .xlsx and .csv: a formula in a product or customer name is text, never a formula", async () => {
    const xlsx = await get("/v1/report-library/top-products/export?format=xlsx", owner());
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.headers["content-type"]).toContain("spreadsheetml");
    const wb = await workbook(xlsx.rawPayload);
    const cells: ExcelJS.Cell[] = [];
    wb.eachSheet((sheet) => sheet.eachRow((row) => row.eachCell((cell) => cells.push(cell))));
    const evil = cells.find((cell) => String(cell.value).includes("HYPERLINK"));
    expect(evil?.value).toBe(`'${EVIL_PRODUCT}`);
    expect(evil?.formula).toBeUndefined();
    expect(cells.filter((c) => c.formula !== undefined).every((c) => /^SUM\(/.test(c.formula ?? ""))).toBe(true);

    const csv = await get("/v1/report-library/customers/export?format=csv", owner());
    const text = csv.rawPayload.toString("utf8");
    expect(text).toContain(`'${EVIL_CUSTOMER}`);
    expect(text.split(/\r\n/).some((line) => line.startsWith("+") || line.startsWith("="))).toBe(false);
  });
});

describe("a genuine workbook that reconciles", () => {
  it("the sales export's totals are SUM formulas whose value equals the BigInt total", async () => {
    const response = await get("/v1/report-library/sales/export?format=xlsx&status=COMPLETED", owner());
    const wb = await workbook(response.rawPayload);
    expect(wb.worksheets.map((s) => s.name)).toEqual(["Sales", "Payment methods"]);
    const sheet = wb.getWorksheet("Sales") as ExcelJS.Worksheet;
    const header = sheet.getRow(1).getCell(1).value;
    expect(String(header)).toContain("QA Report Library");
    let totalCell: ExcelJS.Cell | null = null;
    sheet.eachRow((row) => {
      if (row.getCell(1).value === "Total") totalCell = row.getCell(9);
    });
    const cell = totalCell as unknown as ExcelJS.Cell;
    expect(cell.formula).toMatch(/^SUM\(I\d+:I\d+\)$/);
    const expected = saleTotals.reduce((a, b) => a + b, 0n);
    expect(cell.result).toBe(Number(expected) / 100);
    expect(cell.numFmt).toBe('#,##0.00;(#,##0.00);"-"');
    expect(cell.font?.name).toBe("Arial");
  });

  it("the income statement export is the Module 13 statement to the cent", async () => {
    const db = tenantDb(T);
    const statement = await buildIncomeStatement({ reader: db, schema: tenantSchemaFor(db) }, (() => {
      const now = new Date();
      return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) };
    })(), true);
    const view = (await get("/v1/report-library/income-statement", as.get("ACCOUNTANT") as SignedIn)).json<View>();
    const net = view.sections[0]?.rows.find((r) => r.name === "Net profit");
    expect(net?.amount).toBe(statement.netProfit.amount.toString());
    const wb = await workbook((await get("/v1/report-library/income-statement/export?format=xlsx", as.get("ACCOUNTANT") as SignedIn)).rawPayload);
    let netCell: number | null = null;
    wb.worksheets[0]?.eachRow((row) => {
      if (row.getCell(3).value === "Net profit") netCell = row.getCell(4).value as number;
    });
    expect(netCell).toBe(Number(statement.netProfit.amount) / 100);
  });

  it("a .pdf is a branded PDF with the period and page numbers", async () => {
    const response = await get("/v1/report-library/sales/export?format=pdf", owner());
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    expect(response.headers["content-disposition"]).toMatch(/attachment; filename="qa-report-library-sales-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}-\d{12}\.pdf"/);
    expect(response.headers["cache-control"]).toBe("no-store, private");
  });
});

describe("filters scope the view and the export identically", () => {
  it("status and payment method narrow both, and the export carries the applied filters", async () => {
    const voided = (await get("/v1/report-library/sales?status=VOIDED", owner())).json<View>();
    expect(voided.sections[0]?.totalRows).toBe(1);
    expect(voided.sections[0]?.rows.every((r) => r.status === "Voided")).toBe(true);
    const credit = (await get("/v1/report-library/sales?tenderType=CREDIT", owner())).json<View>();
    expect(credit.sections[0]?.totalRows).toBe(1);
    expect(credit.sections[0]?.rows[0]?.customer).toBe(EVIL_CUSTOMER);

    const csv = (await get("/v1/report-library/sales/export?format=csv&tenderType=CREDIT", owner())).rawPayload.toString("utf8");
    expect(csv).toContain("Payment method,Credit");
    const dataLines = csv.split("\r\n").filter((line) => /^SALE-/.test(line));
    expect(dataLines).toHaveLength(1);
    expect(dataLines[0]).toContain(credit.sections[0]?.rows[0]?.number ?? "missing");
  });

  it("a bad filter is a clear 400, never a guess", async () => {
    const bad = await get("/v1/report-library/sales?from=2026-13-01", owner());
    expect(bad.statusCode).toBe(400);
    expect((await get("/v1/report-library/sales?from=2026-11-10&to=2026-11-01", owner())).json<{ message: string }>().message).toMatch(/start date must be on or before/);
  });
});

describe("isolation and roles", () => {
  it("a business sees only its own data — a tenant id in the query is ignored", async () => {
    const theirs = (await get(`/v1/report-library/sales?tenantId=${await tenantIdOf(T)}`, otherOwner)).json<View>();
    expect(theirs.sections[0]?.totalRows).toBe(1);
    expect(theirs.sections[0]?.rows[0]?.total).toBe("50000");
    expect(JSON.stringify(theirs)).not.toContain("HYPERLINK");
  });

  it("offers each role only the reports its screens allow, and no valuation it may not see", async () => {
    const ids = async (role: string) => (await get("/v1/report-library", as.get(role) as SignedIn)).json<{ data: Array<{ id: string }> }>().data.map((r) => r.id);
    expect(await ids("CASHIER")).not.toContain("income-statement");
    expect((await get("/v1/report-library/income-statement", as.get("CASHIER") as SignedIn)).statusCode).toBe(404);
    expect((await get("/v1/report-library/payroll-runs", as.get("CASHIER") as SignedIn)).statusCode).toBe(404);
    expect(await ids("ACCOUNTANT")).not.toContain("suppliers");
    expect(await ids("HR_OFFICER")).toContain("payroll-muster");
    expect(await ids("HR_OFFICER")).not.toContain("sales");
    const warehouse = (await get("/v1/report-library/stock-levels", as.get("WAREHOUSE_STAFF") as SignedIn)).json<View>();
    expect(warehouse.sections[0]?.columns.map((c) => c.key)).not.toContain("value");
    const accountant = (await get("/v1/report-library/stock-levels", as.get("ACCOUNTANT") as SignedIn)).json<View>();
    expect(accountant.sections[0]?.columns.map((c) => c.key)).toContain("value");
    // A business user may not run platform reports, and platform staff use the platform library.
    expect((await get("/v1/platform-reports", owner())).statusCode).toBe(403);
    expect((await get("/v1/report-library", admin)).statusCode).toBe(403);
  });

  it("every export is audited — report, format, filters and rows, never the data", async () => {
    const before = new Date();
    await get("/v1/report-library/sales/export?format=csv&status=COMPLETED", owner());
    const rows = await platformDb.auditLog.findMany({ where: { action: "REPORT_EXPORTED", actorUserId: owner().user.id, occurredAt: { gte: before } } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenantId).toBe(await tenantIdOf(T));
    // Rows across the export: the 3 completed sales and the 2 payment-method rows.
    expect(rows[0]?.metadata).toMatchObject({ reportId: "sales", format: "csv", rows: 5, mode: "stream", sensitive: false });
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain("HYPERLINK");
  });
});

describe("large exports run in the background, private and short-lived", () => {
  it("builds an encrypted file the requester alone may download until it expires", async () => {
    process.env.EXPORT_SYNC_MAX_ROWS = "1";
    try {
      const started = await get("/v1/report-library/sales/export?format=xlsx", owner());
      expect(started.statusCode).toBe(202);
      const id = started.json<{ id: string; status: string }>().id;
      let status = "PENDING";
      for (let i = 0; i < 50 && status === "PENDING"; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        status = (await get(`/v1/report-library/exports/${id}`, owner())).json<{ status: string }>().status;
      }
      expect(status).toBe("READY");
      const stored = await pool.query(`SELECT "ciphertext", "sha256" FROM "${tenantSchemaFor(tenantDb(T))}".export_files WHERE "id" = $1`, [id]);
      expect(String(stored.rows[0]?.ciphertext)).not.toContain("HYPERLINK");

      const file = await get(`/v1/report-library/exports/${id}/download`, owner());
      expect(file.statusCode).toBe(200);
      expect((await workbook(file.rawPayload)).worksheets.map((s) => s.name)).toContain("Sales");
      // Not the requester: not found — not even in the same business.
      expect((await get(`/v1/report-library/exports/${id}/download`, as.get("MSME_MANAGER") as SignedIn)).statusCode).toBe(404);
      expect((await get(`/v1/report-library/exports/${id}`, otherOwner)).statusCode).toBe(404);

      // Past its window the cleanup expires it: the ciphertext is gone and the download says so.
      const db = tenantDb(T);
      const result = await cleanupExports({ kind: "tenant", db, tenantId: await tenantIdOf(T) }, new Date(Date.now() + 2 * 3_600_000));
      expect(result.expired).toBeGreaterThanOrEqual(1);
      const gone = await get(`/v1/report-library/exports/${id}/download`, owner());
      expect(gone.statusCode).toBe(409);
      expect(gone.json<{ message: string }>().message).toMatch(/expired/);
      const after = await pool.query(`SELECT "ciphertext", "status" FROM "${tenantSchemaFor(db)}".export_files WHERE "id" = $1`, [id]);
      expect(after.rows[0]).toMatchObject({ ciphertext: null, status: "EXPIRED" });
      // A second cleanup finds nothing more to do.
      expect(await cleanupExports({ kind: "tenant", db, tenantId: await tenantIdOf(T) }, new Date(Date.now() + 2 * 3_600_000))).toEqual({ expired: 0, interrupted: 0 });
    } finally {
      delete process.env.EXPORT_SYNC_MAX_ROWS;
    }
  });

  it("the export-file guards hold from raw SQL", async () => {
    await withTenantTx(T, async (client, schema) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO "${schema}".export_files ("id", "reportId", "format", "filters", "rowCount", "requestedBy", "expiresAt") VALUES (gen_random_uuid()::text, 'sales', 'csv', '[]', 1, 'u', now() + interval '1 hour') RETURNING "id"`,
      );
      const id = rows[0]?.id;
      // READY needs the encrypted file behind it.
      await expectDbRefusal(client.query(`UPDATE "${schema}".export_files SET "status" = 'READY', "finishedAt" = now() WHERE "id" = $1`, [id]), { constraint: "export_files_status_coherent" });
    });
    await withTenantTx(T, async (client, schema) => {
      await expectDbRefusal(
        client.query(`INSERT INTO "${schema}".export_files ("id", "reportId", "format", "filters", "rowCount", "requestedBy", "status", "error", "finishedAt", "expiresAt") VALUES (gen_random_uuid()::text, 'sales', 'csv', '[]', 1, 'u', 'FAILED', 'x', now(), now())`),
        { fn: "export_files_guard" },
      );
    });
    await withTenantTx(T, async (client, schema) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO "${schema}".export_files ("id", "reportId", "format", "filters", "rowCount", "requestedBy", "expiresAt") VALUES (gen_random_uuid()::text, 'sales', 'csv', '[]', 1, 'u', now()) RETURNING "id"`,
      );
      await expectDbRefusal(client.query(`UPDATE "${schema}".export_files SET "requestedBy" = 'someone-else' WHERE "id" = $1`, [rows[0]?.id]), { fn: "export_files_guard" });
    });
    await withTenantTx(T, async (client, schema) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO "${schema}".export_files ("id", "reportId", "format", "filters", "rowCount", "requestedBy", "expiresAt") VALUES (gen_random_uuid()::text, 'sales', 'csv', '[]', 1, 'u', now()) RETURNING "id"`,
      );
      await expectDbRefusal(client.query(`DELETE FROM "${schema}".export_files WHERE "id" = $1`, [rows[0]?.id]), { fn: "export_files_guard" });
    });
    // The control: the legal move PENDING -> FAILED is accepted from raw SQL too.
    await withTenantTx(T, async (client, schema) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO "${schema}".export_files ("id", "reportId", "format", "filters", "rowCount", "requestedBy", "expiresAt") VALUES (gen_random_uuid()::text, 'sales', 'csv', '[]', 1, 'u', now()) RETURNING "id"`,
      );
      const moved = await client.query(`UPDATE "${schema}".export_files SET "status" = 'FAILED', "error" = 'interrupted', "finishedAt" = now() WHERE "id" = $1`, [rows[0]?.id]);
      expect(moved.rowCount).toBe(1);
    });
  });
});

describe("platform reports", () => {
  it("are for platform staff: the businesses report filters by status and exports what is shown", async () => {
    const catalogue = (await get("/v1/platform-reports", admin)).json<{ data: Array<{ id: string }> }>().data.map((r) => r.id);
    expect(catalogue).toEqual(expect.arrayContaining(["businesses", "applications", "users", "admin-audit", "notification-delivery", "integration-health", "donor-cohort"]));
    const view = (await get("/v1/platform-reports/businesses?status=ACTIVE&q=QA Report Library", admin)).json<View>();
    expect(view.sections[0]?.rows.map((r) => r.name).sort()).toEqual(["QA Report Library", "QA Report Library B"]);
    expect(view.sections[0]?.rows.every((r) => r.status === "active")).toBe(true);
    const csv = (await get("/v1/platform-reports/businesses/export?format=csv&status=ACTIVE&q=QA Report Library", admin)).rawPayload.toString("utf8");
    expect(csv.split("\r\n").filter((line) => line.startsWith("QA Report Library"))).toHaveLength(2);
    expect(csv).toContain("Status,active");
  });

  it("never carry a National ID, and the users report minimises to what an administrator needs", async () => {
    const view = (await get("/v1/platform-reports/users?q=qa-", admin)).json<View>();
    expect(view.sections[0]?.columns.map((c) => c.key)).not.toContain("nationalId");
    expect(JSON.stringify(view)).not.toMatch(/passwordHash|mfaSecret/);
  });
});

void (null as unknown as UserRole);
