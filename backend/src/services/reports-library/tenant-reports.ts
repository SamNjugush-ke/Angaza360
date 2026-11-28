// ===========================================================================
// A BUSINESS'S OWN REPORTS (M4.5 W4) — the tenant half of the curated library, and what T-B4's
// self-service export runs. Every report reads the SESSION's tenant (context.db) through the
// service that owns the figures — listSales, the stock and procurement services, AR / AP aging,
// expenses, payroll filing and the Module 13 statements — never a parallel calculation. Roles
// mirror the routes behind each figure (a report never shows a role more than its screens do).
// Valuation is shown only to the roles GET /v1/inventory/valuation admits.
// ===========================================================================

import type { UserRole } from "../../generated/platform/client";
import { platformDb } from "../../db/platform";
import { tenantSchemaFor } from "../../db/tenant";
import { businessDateOf, businessToday } from "../../lib/business-time";
import { formatCentsKes } from "../../lib/money";
import { listAllocationRequests } from "../allocation";
import { listPurchaseOrders } from "../procurement";
import { getArAging, listCustomerReceipts } from "../receivables";
import { getApAging, listSupplierBills } from "../payables";
import { listExpenses } from "../expenses";
import { listPayrollRuns } from "../payroll";
import { buildMusterRoll, buildStatutorySummary } from "../payroll-filing";
import { getStockLevels } from "../inventory";
import { listSales } from "../sales";
import { buildDashboardTrend } from "../dashboard";
import {
  buildBalanceSheet,
  buildCashFlow,
  buildControlReconciliation,
  buildIncomeStatement,
  buildTopProducts,
  buildTrialBalance,
  buildVatReturn,
  type ReportLine,
  type ReportSection,
} from "../reports";
import type { Column, Row } from "../export/model";
import { isoDay } from "../export/values";
import {
  applied,
  bounded,
  businessWindow,
  dateFilter,
  doc,
  enumFilter,
  intFilter,
  matches,
  PERIOD_FILTERS,
  periodFilter,
  periodOf,
  ReportFilterError,
  textFilter,
  type FilterSpec,
  type TenantContext,
  type TenantReport,
} from "./library";

const OWNER = "MSME_OWNER";
const MANAGER = "MSME_MANAGER";
const ACCOUNTANT = "ACCOUNTANT";
const VIEWER = "VIEWER_AUDITOR";
const CASHIER = "CASHIER";
const WAREHOUSE = "WAREHOUSE_STAFF";
const HR = "HR_OFFICER";

const SALES_ROLES: UserRole[] = [OWNER, MANAGER, ACCOUNTANT, VIEWER, CASHIER];
const STOCK_ROLES: UserRole[] = [OWNER, MANAGER, ACCOUNTANT, WAREHOUSE, CASHIER, VIEWER];
const VALUATION_ROLES: UserRole[] = [OWNER, ACCOUNTANT, VIEWER];
const PROCUREMENT_ROLES: UserRole[] = [OWNER, MANAGER, WAREHOUSE, ACCOUNTANT, VIEWER];
const MONEY_ROLES: UserRole[] = [OWNER, MANAGER, ACCOUNTANT, VIEWER];
const SUPPLIER_ROLES: UserRole[] = [OWNER, MANAGER];
const CUSTOMER_ROLES: UserRole[] = [OWNER, MANAGER];
const PAYROLL_ROLES: UserRole[] = [OWNER, MANAGER, HR, ACCOUNTANT, VIEWER];
const ALLOCATION_ROLES: UserRole[] = [OWNER, MANAGER, WAREHOUSE];
const OPS_ROLES: UserRole[] = [OWNER, MANAGER, ACCOUNTANT];

const qty = (value: { toString(): string } | string | null | undefined) => (value === null || value === undefined ? null : value.toString());
const source = (context: TenantContext) => ({ reader: context.db, schema: tenantSchemaFor(context.db) });

async function names(context: TenantContext) {
  const [locations, customers] = await Promise.all([
    context.db.location.findMany({ select: { id: true, name: true, isDefault: true } }),
    context.db.customer.findMany({ select: { id: true, name: true } }),
  ]);
  const main = locations.find((l) => l.isDefault);
  return {
    location: (id: string | null) => (id === null ? (main?.name ?? "Main") : (locations.find((l) => l.id === id)?.name ?? id)),
    customer: (id: string | null) => (id === null ? "Walk-in" : (customers.find((c) => c.id === id)?.name ?? id)),
    locationName: (id: string | undefined) => (id === undefined ? undefined : (locations.find((l) => l.id === id)?.name ?? id)),
    customerName: (id: string | undefined) => (id === undefined ? undefined : (customers.find((c) => c.id === id)?.name ?? id)),
    mainId: main?.id ?? null,
  };
}

const TENDER_TYPES = ["CASH", "MPESA", "BANK_TRANSFER", "CREDIT"] as const;
const TENDER_LABEL: Record<string, string> = { CASH: "Cash", MPESA: "M-Pesa", BANK_TRANSFER: "Bank transfer", CREDIT: "Credit" };

// ---- Operations ------------------------------------------------------------

const sales: TenantReport = {
  id: "sales",
  title: "Sales",
  description: "Every sale in the period, with its location, customer, payment methods and totals, and the payment-method mix.",
  category: "operations",
  roles: SALES_ROLES,
  sensitive: false,
  filters: [
    ...PERIOD_FILTERS,
    { key: "status", label: "Status", type: "select", options: [{ value: "COMPLETED", label: "Completed" }, { value: "VOIDED", label: "Voided" }] },
    { key: "tenderType", label: "Payment method", type: "select", options: TENDER_TYPES.map((t) => ({ value: t, label: TENDER_LABEL[t] ?? t })) },
    { key: "locationId", label: "Location", type: "entity", entity: "location" },
    { key: "customerId", label: "Customer", type: "entity", entity: "customer" },
    { key: "q", label: "Sale number", type: "search" },
  ],
  async run(context, query) {
    const period = periodFilter(query);
    const status = enumFilter(query, "status", "Status", ["COMPLETED", "VOIDED"] as const);
    const tenderType = enumFilter(query, "tenderType", "Payment method", TENDER_TYPES);
    const locationId = textFilter(query, "locationId");
    const customerId = textFilter(query, "customerId");
    const q = textFilter(query, "q");
    const n = await names(context);
    const all = [];
    for (let skip = 0; ; skip += 500) {
      const page = await listSales(context.db, { from: period.from, to: period.to, ...(status ? { status } : {}), ...(customerId ? { customerId } : {}), ...(q ? { q } : {}), take: 500, skip });
      all.push(...page.data);
      bounded(all, "sales");
      if (page.data.length < 500) break;
    }
    const rows = all.filter(
      (sale) =>
        (locationId === undefined || (sale.sellingLocationId ?? n.mainId) === locationId) &&
        (tenderType === undefined || sale.tenders.some((t) => t.tenderType === tenderType)),
    );
    const mix = new Map<string, { count: number; amount: bigint }>();
    for (const sale of rows) {
      if (sale.status !== "COMPLETED") continue;
      for (const tender of sale.tenders) {
        if (tender.status !== "CONFIRMED") continue;
        const key = tender.tenderType === "MPESA" && tender.mpesaChannel ? `M-Pesa (${tender.mpesaChannel})` : (TENDER_LABEL[tender.tenderType] ?? tender.tenderType);
        const now = mix.get(key) ?? { count: 0, amount: 0n };
        mix.set(key, { count: now.count + 1, amount: now.amount + tender.amount });
      }
    }
    const columns: Column[] = [
      { key: "number", header: "Sale", kind: "text", width: 22 },
      { key: "date", header: "Date", kind: "date" },
      { key: "location", header: "Location", kind: "text", width: 16 },
      { key: "customer", header: "Customer", kind: "text", width: 22 },
      { key: "status", header: "Status", kind: "text", width: 11 },
      { key: "methods", header: "Paid by", kind: "text", width: 20 },
      { key: "subtotal", header: "Net (KES)", kind: "money", total: true },
      { key: "vat", header: "VAT (KES)", kind: "money", total: true },
      { key: "total", header: "Total (KES)", kind: "money", total: true },
    ];
    return doc({
      reportId: "sales",
      title: "Sales",
      brand: context.brand,
      period: periodOf(period),
      filters: applied(["Status", status === "VOIDED" ? "Voided" : status === "COMPLETED" ? "Completed" : "All"], ["Payment method", tenderType ? TENDER_LABEL[tenderType] : undefined], ["Location", n.locationName(locationId)], ["Customer", n.customerName(customerId)], ["Sale number contains", q]),
      sections: [
        {
          name: "Sales",
          columns,
          rows: rows.map((sale) => ({
            number: sale.saleNumber,
            date: isoDay(businessDateOf(sale.businessTimestamp ?? sale.createdAt)),
            location: n.location(sale.sellingLocationId),
            customer: n.customer(sale.customerId),
            status: sale.status === "VOIDED" ? "Voided" : "Completed",
            methods: [...new Set(sale.tenders.map((t) => TENDER_LABEL[t.tenderType] ?? t.tenderType))].join(", "),
            subtotal: sale.subtotal,
            vat: sale.vatTotal,
            total: sale.total,
          })),
        },
        {
          name: "Payment methods",
          note: "Confirmed payments on completed sales in the rows above.",
          columns: [
            { key: "method", header: "Payment method", kind: "text" },
            { key: "count", header: "Payments", kind: "integer", total: true },
            { key: "amount", header: "Amount (KES)", kind: "money", total: true },
          ],
          rows: [...mix.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([method, v]) => ({ method, count: BigInt(v.count), amount: v.amount })),
        },
      ],
    });
  },
};

const topProducts: TenantReport = {
  id: "top-products",
  title: "Top-selling products",
  description: "Products ranked by net revenue or quantity sold in the period — the income statement's own revenue basis.",
  category: "operations",
  roles: MONEY_ROLES,
  sensitive: false,
  filters: [...PERIOD_FILTERS, { key: "by", label: "Rank by", type: "select", options: [{ value: "revenue", label: "Revenue" }, { value: "quantity", label: "Quantity" }] }, { key: "limit", label: "How many", type: "number", defaultHint: "10" }],
  async run(context, query) {
    const period = periodFilter(query);
    const by = enumFilter(query, "by", "Rank by", ["revenue", "quantity"] as const) ?? "revenue";
    const limit = intFilter(query, "limit", "How many", 1, 50, 10);
    const top = await buildTopProducts(source(context), period, { limit, by });
    return doc({
      reportId: "top-products",
      title: "Top-selling products",
      brand: context.brand,
      period: periodOf(period),
      filters: applied(["Ranked by", by === "revenue" ? "Net revenue" : "Quantity"], ["Showing", `top ${limit.toString()}`]),
      sections: [
        {
          name: "Top products",
          columns: [
            { key: "rank", header: "#", kind: "integer", width: 5 },
            { key: "sku", header: "SKU", kind: "text", width: 14 },
            { key: "name", header: "Product", kind: "text" },
            { key: "kind", header: "Kind", kind: "text", width: 9 },
            { key: "quantity", header: "Quantity", kind: "quantity", total: true },
            { key: "revenue", header: "Net revenue (KES)", kind: "money", total: true },
          ],
          rows: top.map((p, i) => ({ rank: BigInt(i + 1), sku: p.sku, name: p.name, kind: p.kind === "SERVICE" ? "Service" : "Good", quantity: p.quantity, revenue: p.revenue })),
        },
      ],
    });
  },
};

const stockLevels: TenantReport = {
  id: "stock-levels",
  title: "Stock levels",
  description: "What the business holds, by product or at one location, with reorder flags; value for the roles that may see it.",
  category: "operations",
  roles: STOCK_ROLES,
  sensitive: false,
  filters: [
    { key: "locationId", label: "Location", type: "entity", entity: "location", defaultHint: "every location" },
    { key: "belowReorder", label: "Only below reorder level", type: "select", options: [{ value: "true", label: "Yes" }] },
    { key: "q", label: "Product", type: "search" },
  ],
  async run(context, query) {
    const locationId = textFilter(query, "locationId");
    const below = textFilter(query, "belowReorder") === "true";
    const q = textFilter(query, "q");
    const valued = VALUATION_ROLES.includes(context.role);
    const n = await names(context);
    let rows: Row[];
    let columns: Column[];
    if (locationId === undefined) {
      const levels = await getStockLevels(context.db, { belowReorderOnly: below });
      rows = levels.filter((r) => matches(q, r.sku, r.name, r.category)).map((r) => ({ sku: r.sku, name: r.name, category: r.category, unit: r.unitOfMeasure, quantity: r.stockCount, reorder: r.minStockThreshold, flag: r.belowReorder ? "Reorder" : "", ...(valued ? { value: r.stockValue } : {}) }));
      columns = [
        { key: "sku", header: "SKU", kind: "text", width: 14 },
        { key: "name", header: "Product", kind: "text" },
        { key: "category", header: "Category", kind: "text", width: 16 },
        { key: "unit", header: "Unit", kind: "text", width: 8 },
        { key: "quantity", header: "On hand", kind: "quantity", total: true },
        { key: "reorder", header: "Reorder at", kind: "quantity" },
        { key: "flag", header: "", kind: "text", width: 9 },
        ...(valued ? [{ key: "value", header: "Carrying value (KES)", kind: "money" as const, total: true }] : []),
      ];
    } else {
      const slices = await context.db.productLocationStock.findMany({ where: { locationId, product: { kind: "GOOD" } }, include: { product: { select: { sku: true, name: true, unitOfMeasure: true, minStockThreshold: true, isActive: true } } }, orderBy: { product: { sku: "asc" } } });
      rows = slices
        .filter((s) => matches(q, s.product.sku, s.product.name))
        .filter((s) => !below || (s.product.minStockThreshold.greaterThan(0) && s.quantity.minus(s.frozenQuantity).lessThanOrEqualTo(s.product.minStockThreshold)))
        .map((s) => ({ sku: s.product.sku, name: s.product.name, unit: s.product.unitOfMeasure, quantity: s.quantity.toFixed(3), frozen: s.frozenQuantity.toFixed(3), sellable: s.quantity.minus(s.frozenQuantity).toFixed(3), reorder: s.product.minStockThreshold.toFixed(3) }));
      columns = [
        { key: "sku", header: "SKU", kind: "text", width: 14 },
        { key: "name", header: "Product", kind: "text" },
        { key: "unit", header: "Unit", kind: "text", width: 8 },
        { key: "quantity", header: "Owned", kind: "quantity", total: true },
        { key: "frozen", header: "Frozen", kind: "quantity", total: true },
        { key: "sellable", header: "Sellable", kind: "quantity", total: true },
        { key: "reorder", header: "Reorder at", kind: "quantity" },
      ];
    }
    return doc({
      reportId: "stock-levels",
      title: "Stock levels",
      brand: context.brand,
      period: { from: isoDay(businessToday()), to: isoDay(businessToday()) },
      filters: applied(["Location", n.locationName(locationId) ?? "Every location"], ["Only below reorder level", below ? "Yes" : undefined], ["Product contains", q]),
      sections: [{ name: "Stock", columns, rows: bounded(rows, "products"), note: valued || locationId !== undefined ? undefined : "Carrying value is shown to the owner, accountant and auditor only." }],
    });
  },
};

const MOVEMENT_TYPES = ["PURCHASE_RECEIPT", "SALE", "SALE_RETURN", "PURCHASE_RETURN", "ADJUSTMENT_INCREASE", "ADJUSTMENT_DECREASE", "WRITE_OFF", "TRANSFER_IN", "TRANSFER_OUT", "OPENING_BALANCE"] as const;

const stockMovements: TenantReport = {
  id: "stock-movements",
  title: "Stock movements",
  description: "Every movement of stock in the period — receipts, sales, returns, adjustments, write-offs and transfers.",
  category: "operations",
  roles: STOCK_ROLES,
  sensitive: false,
  filters: [
    ...PERIOD_FILTERS,
    { key: "productId", label: "Product", type: "entity", entity: "product" },
    { key: "locationId", label: "Location", type: "entity", entity: "location" },
    { key: "movementType", label: "Movement", type: "select", options: MOVEMENT_TYPES.map((t) => ({ value: t, label: t.replace(/_/g, " ").toLowerCase() })) },
  ],
  async run(context, query) {
    const period = periodFilter(query);
    const productId = textFilter(query, "productId");
    const locationId = textFilter(query, "locationId");
    const movementType = enumFilter(query, "movementType", "Movement", MOVEMENT_TYPES);
    const valued = VALUATION_ROLES.includes(context.role);
    const n = await names(context);
    const { start, endExclusive: end } = businessWindow(period);
    const movements = await context.db.stockMovement.findMany({
      where: {
        createdAt: { gte: start, lt: end },
        ...(productId ? { productId } : {}),
        ...(movementType ? { movementType } : {}),
        ...(locationId ? (locationId === n.mainId ? { OR: [{ locationId }, { locationId: null }] } : { locationId }) : {}),
      },
      include: { product: { select: { sku: true, name: true } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 50_001,
    });
    const product = productId ? movements[0]?.product.name ?? productId : undefined;
    return doc({
      reportId: "stock-movements",
      title: "Stock movements",
      brand: context.brand,
      period: periodOf(period),
      filters: applied(["Product", product], ["Location", n.locationName(locationId)], ["Movement", movementType?.replace(/_/g, " ").toLowerCase()]),
      sections: [
        {
          name: "Movements",
          note: "A location left blank on a movement recorded before locations existed means the main store.",
          columns: [
            { key: "at", header: "When", kind: "datetime" },
            { key: "sku", header: "SKU", kind: "text", width: 14 },
            { key: "name", header: "Product", kind: "text" },
            { key: "type", header: "Movement", kind: "text", width: 18 },
            { key: "location", header: "Location", kind: "text", width: 16 },
            { key: "quantity", header: "Quantity", kind: "quantity" },
            { key: "balance", header: "Balance after", kind: "quantity" },
            ...(valued ? [{ key: "cost", header: "Value (KES)", kind: "money" as const }] : []),
            { key: "reference", header: "Reference", kind: "text", width: 16 },
          ],
          rows: bounded(movements, "movements").map((m) => ({
            at: m.createdAt,
            sku: m.product.sku,
            name: m.product.name,
            type: m.movementType.replace(/_/g, " ").toLowerCase(),
            location: n.location(m.locationId),
            quantity: qty(m.quantity),
            balance: qty(m.balanceQty),
            ...(valued ? { cost: m.totalCost } : {}),
            reference: m.reference,
          })),
        },
      ],
    });
  },
};

const ALLOCATION_STATUSES = ["PENDING", "APPROVED", "DECLINED", "CANCELLED"] as const;

const allocations: TenantReport = {
  id: "allocations",
  title: "Stock requests and allocations",
  description: "Cashiers' stock requests and how each was decided.",
  category: "operations",
  roles: ALLOCATION_ROLES,
  sensitive: false,
  filters: [
    ...PERIOD_FILTERS,
    { key: "status", label: "Status", type: "select", options: ALLOCATION_STATUSES.map((s) => ({ value: s, label: s.toLowerCase() })) },
    { key: "locationId", label: "Location", type: "entity", entity: "location" },
    { key: "productId", label: "Product", type: "entity", entity: "product" },
  ],
  async run(context, query) {
    const period = periodFilter(query);
    const status = enumFilter(query, "status", "Status", ALLOCATION_STATUSES);
    const locationId = textFilter(query, "locationId");
    const productId = textFilter(query, "productId");
    const n = await names(context);
    const { start: startInclusive, endExclusive } = businessWindow(period);
    const rows = (await listAllocationRequests(context.db, { ...(status ? { status } : {}), ...(locationId ? { locationId } : {}), ...(productId ? { productId } : {}) })).filter(
      (r) => r.createdAt >= startInclusive && r.createdAt < endExclusive,
    );
    return doc({
      reportId: "allocations",
      title: "Stock requests and allocations",
      brand: context.brand,
      period: periodOf(period),
      filters: applied(["Status", status?.toLowerCase()], ["Location", n.locationName(locationId)], ["Product", productId ? rows[0]?.productName ?? productId : undefined]),
      sections: [
        {
          name: "Requests",
          columns: [
            { key: "at", header: "Asked", kind: "datetime" },
            { key: "location", header: "For", kind: "text", width: 16 },
            { key: "sku", header: "SKU", kind: "text", width: 14 },
            { key: "name", header: "Product", kind: "text" },
            { key: "requested", header: "Asked for", kind: "quantity", total: true },
            { key: "approved", header: "Sent", kind: "quantity", total: true },
            { key: "status", header: "Status", kind: "text", width: 11 },
            { key: "decidedAt", header: "Decided", kind: "datetime" },
          ],
          rows: bounded(rows, "requests").map((r) => ({ at: r.createdAt, location: r.locationName, sku: r.sku, name: r.productName, requested: r.requestedQty, approved: r.approvedQty, status: r.status.toLowerCase(), decidedAt: r.decidedAt })),
        },
      ],
    });
  },
};

const PO_STATUSES = ["DRAFT", "APPROVED", "PARTIALLY_RECEIVED", "RECEIVED", "CLOSED", "CANCELLED"] as const;

const purchaseOrders: TenantReport = {
  id: "purchase-orders",
  title: "Purchase orders",
  description: "Purchase orders raised in the period, by supplier and status, with what has been received.",
  category: "operations",
  roles: PROCUREMENT_ROLES,
  sensitive: false,
  filters: [...PERIOD_FILTERS, { key: "status", label: "Status", type: "select", options: PO_STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, " ").toLowerCase() })) }, { key: "supplierId", label: "Supplier", type: "entity", entity: "supplier" }],
  async run(context, query) {
    const period = periodFilter(query);
    const status = enumFilter(query, "status", "Status", PO_STATUSES);
    const supplierId = textFilter(query, "supplierId");
    const orders = (await listPurchaseOrders(context.db, { ...(status ? { status } : {}), ...(supplierId ? { supplierId } : {}) })).filter((o) => o.orderDate >= period.from && o.orderDate <= period.to);
    return doc({
      reportId: "purchase-orders",
      title: "Purchase orders",
      brand: context.brand,
      period: periodOf(period),
      filters: applied(["Status", status?.replace(/_/g, " ").toLowerCase()], ["Supplier", supplierId ? orders[0]?.supplierName ?? supplierId : undefined]),
      sections: [
        {
          name: "Purchase orders",
          columns: [
            { key: "number", header: "PO", kind: "integer", width: 8 },
            { key: "date", header: "Ordered", kind: "date" },
            { key: "supplier", header: "Supplier", kind: "text" },
            { key: "status", header: "Status", kind: "text", width: 18 },
            { key: "lines", header: "Lines", kind: "integer", width: 7 },
            { key: "subtotal", header: "Value (KES)", kind: "money", total: true },
          ],
          rows: bounded(orders, "orders").map((o) => ({ number: BigInt(o.poNumber), date: isoDay(o.orderDate), supplier: o.supplierName, status: o.status.replace(/_/g, " ").toLowerCase(), lines: BigInt(o.lines.length), subtotal: o.subtotal })),
        },
      ],
    });
  },
};

const suppliers: TenantReport = {
  id: "suppliers",
  title: "Suppliers",
  description: "The supplier list with contact details and payment terms.",
  category: "operations",
  roles: SUPPLIER_ROLES,
  sensitive: false,
  filters: [{ key: "q", label: "Supplier", type: "search" }],
  async run(context, query) {
    const q = textFilter(query, "q");
    const rows = (await context.db.supplier.findMany({ orderBy: [{ name: "asc" }, { id: "asc" }] })).filter((s) => matches(q, s.name, s.contactName, s.email, s.phone));
    return doc({
      reportId: "suppliers",
      title: "Suppliers",
      brand: context.brand,
      period: null,
      filters: applied(["Name contains", q]),
      sections: [
        {
          name: "Suppliers",
          columns: [
            { key: "name", header: "Supplier", kind: "text" },
            { key: "contact", header: "Contact", kind: "text", width: 18 },
            { key: "phone", header: "Phone", kind: "text", width: 15 },
            { key: "email", header: "Email", kind: "text", width: 24 },
            { key: "kraPin", header: "KRA PIN", kind: "text", width: 13 },
            { key: "terms", header: "Payment terms", kind: "text", width: 14 },
            { key: "active", header: "Active", kind: "text", width: 7 },
          ],
          rows: bounded(rows, "suppliers").map((s) => ({ name: s.name, contact: s.contactName, phone: s.phone, email: s.email, kraPin: s.kraPin, terms: s.paymentTerms, active: s.isActive ? "Yes" : "No" })),
        },
      ],
    });
  },
};

const customers: TenantReport = {
  id: "customers",
  title: "Customers",
  description: "The customer list with credit limits, balances owed and loyalty points.",
  category: "operations",
  roles: CUSTOMER_ROLES,
  sensitive: false,
  filters: [{ key: "q", label: "Customer", type: "search" }, { key: "owing", label: "Only those who owe", type: "select", options: [{ value: "true", label: "Yes" }] }],
  async run(context, query) {
    const q = textFilter(query, "q");
    const owing = textFilter(query, "owing") === "true";
    const rows = (await context.db.customer.findMany({ orderBy: [{ name: "asc" }, { id: "asc" }] })).filter((c) => matches(q, c.name, c.phone, c.email) && (!owing || c.creditBalance > 0n));
    return doc({
      reportId: "customers",
      title: "Customers",
      brand: context.brand,
      period: null,
      filters: applied(["Name contains", q], ["Only those who owe", owing ? "Yes" : undefined]),
      sections: [
        {
          name: "Customers",
          columns: [
            { key: "name", header: "Customer", kind: "text" },
            { key: "phone", header: "Phone", kind: "text", width: 15 },
            { key: "email", header: "Email", kind: "text", width: 24 },
            { key: "limit", header: "Credit limit (KES)", kind: "money" },
            { key: "balance", header: "Owes (KES)", kind: "money", total: true },
            { key: "points", header: "Loyalty points", kind: "integer" },
            { key: "active", header: "Active", kind: "text", width: 7 },
          ],
          rows: bounded(rows, "customers").map((c) => ({ name: c.name, phone: c.phone, email: c.email, limit: c.creditLimit, balance: c.creditBalance, points: BigInt(c.loyaltyPoints), active: c.isActive ? "Yes" : "No" })),
        },
      ],
    });
  },
};

const agingColumns = (who: string, dateHeader: string): Column[] => [
  { key: "name", header: who, kind: "text" },
  { key: "current", header: "Current (KES)", kind: "money", total: true },
  { key: "d30", header: "1–30 days", kind: "money", total: true },
  { key: "d60", header: "31–60 days", kind: "money", total: true },
  { key: "d90", header: "61–90 days", kind: "money", total: true },
  { key: "over90", header: "Over 90 days", kind: "money", total: true },
  { key: "total", header: "Total (KES)", kind: "money", total: true },
  { key: "oldest", header: dateHeader, kind: "date" },
];

const receivablesAging: TenantReport = {
  id: "receivables-aging",
  title: "Receivables aging",
  description: "What each customer owes, by how long since the sale — ties to Accounts Receivable.",
  category: "financial",
  roles: MONEY_ROLES,
  sensitive: false,
  filters: [{ key: "asOf", label: "As at", type: "date", defaultHint: "now" }],
  async run(context, query) {
    const asOf = dateFilter(query, "asOf", "As at");
    const report = await getArAging(context.db, asOf);
    return doc({
      reportId: "receivables-aging",
      title: "Receivables aging",
      brand: context.brand,
      period: { from: isoDay(report.asOf), to: isoDay(report.asOf) },
      filters: applied(["As at", asOf ? isoDay(asOf) : "now"]),
      sections: [{ name: "Aging", columns: agingColumns("Customer", "Oldest sale"), rows: report.customers.map((c) => ({ name: c.customerName, current: c.current, d30: c.days1To30, d60: c.days31To60, d90: c.days61To90, over90: c.over90, total: c.total, oldest: c.oldestSaleDate ? isoDay(c.oldestSaleDate) : null })) }],
    });
  },
};

const payablesAging: TenantReport = {
  id: "payables-aging",
  title: "Payables aging",
  description: "What the business owes each supplier, by how long past the due date.",
  category: "financial",
  roles: MONEY_ROLES,
  sensitive: false,
  filters: [{ key: "asOf", label: "As at", type: "date", defaultHint: "today" }],
  async run(context, query) {
    const asOf = dateFilter(query, "asOf", "As at");
    const report = await getApAging(context.db, asOf ?? new Date());
    return doc({
      reportId: "payables-aging",
      title: "Payables aging",
      brand: context.brand,
      period: { from: isoDay(businessDateOf(report.asOf)), to: isoDay(businessDateOf(report.asOf)) },
      filters: applied(["As at", asOf ? isoDay(asOf) : "today"]),
      sections: [{ name: "Aging", columns: agingColumns("Supplier", "Oldest due"), rows: report.suppliers.map((s) => ({ name: s.supplierName, current: s.current, d30: s.days1To30, d60: s.days31To60, d90: s.days61To90, over90: s.over90, total: s.total, oldest: s.oldestDueDate ? isoDay(s.oldestDueDate) : null })) }],
    });
  },
};

const BILL_STATUSES = ["DRAFT", "AWAITING_PAYMENT", "PARTIALLY_PAID", "PAID", "CANCELLED"] as const;

const supplierBills: TenantReport = {
  id: "supplier-bills",
  title: "Supplier bills",
  description: "Supplier invoices dated in the period, with what has been paid and what is still owed.",
  category: "financial",
  roles: MONEY_ROLES,
  sensitive: false,
  filters: [...PERIOD_FILTERS, { key: "status", label: "Status", type: "select", options: BILL_STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, " ").toLowerCase() })) }, { key: "supplierId", label: "Supplier", type: "entity", entity: "supplier" }],
  async run(context, query) {
    const period = periodFilter(query);
    const status = enumFilter(query, "status", "Status", BILL_STATUSES);
    const supplierId = textFilter(query, "supplierId");
    const bills = (await listSupplierBills(context.db, { ...(status ? { status } : {}), ...(supplierId ? { supplierId } : {}) })).filter((b) => b.billDate >= period.from && b.billDate <= period.to);
    return doc({
      reportId: "supplier-bills",
      title: "Supplier bills",
      brand: context.brand,
      period: periodOf(period),
      filters: applied(["Status", status?.replace(/_/g, " ").toLowerCase()], ["Supplier", supplierId ? bills[0]?.supplierName ?? supplierId : undefined]),
      sections: [
        {
          name: "Bills",
          columns: [
            { key: "number", header: "Invoice", kind: "text", width: 16 },
            { key: "supplier", header: "Supplier", kind: "text" },
            { key: "date", header: "Dated", kind: "date" },
            { key: "due", header: "Due", kind: "date" },
            { key: "status", header: "Status", kind: "text", width: 16 },
            { key: "total", header: "Total (KES)", kind: "money", total: true },
            { key: "paid", header: "Paid (KES)", kind: "money", total: true },
            { key: "balance", header: "Owed (KES)", kind: "money", total: true },
          ],
          rows: bounded(bills, "bills").map((b) => ({ number: b.billNumber, supplier: b.supplierName, date: isoDay(b.billDate), due: isoDay(b.dueDate), status: b.status.replace(/_/g, " ").toLowerCase(), total: b.total, paid: b.amountPaid, balance: b.balance })),
        },
      ],
    });
  },
};

const RECEIPT_METHODS = ["CASH", "BANK", "MPESA"] as const;

const customerReceipts: TenantReport = {
  id: "customer-receipts",
  title: "Customer receipts",
  description: "Money collected from customers on account in the period.",
  category: "financial",
  roles: MONEY_ROLES,
  sensitive: false,
  filters: [...PERIOD_FILTERS, { key: "method", label: "Method", type: "select", options: RECEIPT_METHODS.map((m) => ({ value: m, label: m === "MPESA" ? "M-Pesa" : m.toLowerCase() })) }, { key: "customerId", label: "Customer", type: "entity", entity: "customer" }],
  async run(context, query) {
    const period = periodFilter(query);
    const method = enumFilter(query, "method", "Method", RECEIPT_METHODS);
    const customerId = textFilter(query, "customerId");
    const receipts = await listCustomerReceipts(context.db, { from: period.from, to: period.to, ...(method ? { method } : {}), ...(customerId ? { customerId } : {}) });
    return doc({
      reportId: "customer-receipts",
      title: "Customer receipts",
      brand: context.brand,
      period: periodOf(period),
      filters: applied(["Method", method], ["Customer", customerId ? receipts[0]?.customerName ?? customerId : undefined]),
      sections: [
        {
          name: "Receipts",
          columns: [
            { key: "number", header: "Receipt", kind: "integer", width: 9 },
            { key: "date", header: "Date", kind: "date" },
            { key: "customer", header: "Customer", kind: "text" },
            { key: "method", header: "Method", kind: "text", width: 9 },
            { key: "reference", header: "Reference", kind: "text", width: 16 },
            { key: "amount", header: "Amount (KES)", kind: "money", total: true },
          ],
          rows: bounded(receipts, "receipts").map((r) => ({ number: BigInt(r.receiptNumber), date: isoDay(r.receiptDate), customer: r.customerName, method: r.method, reference: r.reference, amount: r.amount })),
        },
      ],
    });
  },
};

const EXPENSE_METHODS = ["CASH", "MPESA", "BANK"] as const;

const expenses: TenantReport = {
  id: "expenses",
  title: "Expenses",
  description: "Expenses paid in the period, by category and payment method.",
  category: "financial",
  roles: MONEY_ROLES,
  sensitive: false,
  filters: [
    ...PERIOD_FILTERS,
    { key: "category", label: "Category (account code)", type: "search" },
    { key: "method", label: "Paid from", type: "select", options: EXPENSE_METHODS.map((m) => ({ value: m, label: m === "MPESA" ? "M-Pesa" : m.toLowerCase() })) },
    { key: "includeVoided", label: "Include voided", type: "select", options: [{ value: "true", label: "Yes" }] },
  ],
  async run(context, query) {
    const period = periodFilter(query);
    const category = textFilter(query, "category", 10);
    const method = enumFilter(query, "method", "Paid from", EXPENSE_METHODS);
    const includeVoided = textFilter(query, "includeVoided") === "true";
    const accounts = await context.db.account.findMany({ where: { code: { startsWith: "6" } }, select: { code: true, name: true } });
    const nameOf = (code: string) => accounts.find((a) => a.code === code)?.name ?? code;
    const rows = (await listExpenses(context.db, { from: period.from, to: period.to, category: category ?? null, includeVoided })).filter((e) => method === undefined || e.paymentMethod === method);
    return doc({
      reportId: "expenses",
      title: "Expenses",
      brand: context.brand,
      period: periodOf(period),
      filters: applied(["Category", category ? `${category} ${nameOf(category)}` : undefined], ["Paid from", method], ["Voided", includeVoided ? "Included" : "Left out"]),
      sections: [
        {
          name: "Expenses",
          columns: [
            { key: "date", header: "Date", kind: "date" },
            { key: "category", header: "Category", kind: "text", width: 24 },
            { key: "payee", header: "Payee", kind: "text", width: 18 },
            { key: "description", header: "Description", kind: "text" },
            { key: "method", header: "Paid from", kind: "text", width: 9 },
            { key: "status", header: "Status", kind: "text", width: 8 },
            { key: "amount", header: "Amount (KES)", kind: "money", total: true },
          ],
          rows: bounded(rows, "expenses").map((e) => ({ date: isoDay(e.expenseDate), category: `${e.category} ${nameOf(e.category)}`, payee: e.payee, description: e.description, method: e.paymentMethod, status: e.isVoided ? "Voided" : "", amount: e.isVoided ? 0n : e.amountCents })),
          note: includeVoided ? "A voided expense is listed at zero: its reversal cancelled it." : undefined,
        },
      ],
    });
  },
};

// ---- The seven statements, laid out as the engine computed them ----------

const lineRows = (heading: string, section: ReportSection, totalLabel: string): Row[] => [
  ...section.lines.map((line: ReportLine) => ({ part: heading, code: line.code, name: line.name, amount: line.amount, comparative: line.comparativeAmount })),
  { part: heading, code: null, name: totalLabel, amount: section.total, comparative: section.comparativeTotal },
];

const STATEMENT_COLUMNS: Column[] = [
  { key: "part", header: "Section", kind: "text", width: 22 },
  { key: "code", header: "Account", kind: "text", width: 9 },
  { key: "name", header: "Line", kind: "text", width: 36 },
  { key: "amount", header: "This period (KES)", kind: "money" },
  { key: "comparative", header: "Comparative (KES)", kind: "money" },
];

const FINANCIAL_ROLES: UserRole[] = [OWNER, MANAGER, ACCOUNTANT, VIEWER];
const comparativeFilter: FilterSpec = { key: "comparative", label: "Comparative", type: "select", options: [{ value: "false", label: "Leave out" }], defaultHint: "shown" };

const incomeStatement: TenantReport = {
  id: "income-statement",
  title: "Income statement",
  description: "Revenue, cost of sales, gross profit, operating expenses and net profit, with the comparative period.",
  category: "financial",
  roles: FINANCIAL_ROLES,
  sensitive: false,
  filters: [...PERIOD_FILTERS, comparativeFilter],
  async run(context, query) {
    const period = periodFilter(query);
    const withComparative = textFilter(query, "comparative") !== "false";
    const s = await buildIncomeStatement(source(context), period, withComparative);
    return doc({
      reportId: "income-statement",
      title: "Income statement",
      brand: context.brand,
      period: periodOf(period),
      filters: applied(["Comparative", s.comparativePeriod ? `${isoDay(s.comparativePeriod.from)} to ${isoDay(s.comparativePeriod.to)}` : "Left out"]),
      sections: [
        {
          name: "Income statement",
          columns: STATEMENT_COLUMNS,
          rows: [
            ...lineRows("Revenue", s.revenue, "Total revenue"),
            ...lineRows("Cost of sales", s.costOfSales, "Total cost of sales"),
            { part: "Gross profit", code: null, name: "Gross profit", amount: s.grossProfit.amount, comparative: s.grossProfit.comparativeAmount },
            ...lineRows("Operating expenses", s.operatingExpenses, "Total operating expenses"),
            { part: "Net profit", code: null, name: "Net profit", amount: s.netProfit.amount, comparative: s.netProfit.comparativeAmount },
          ],
          note: "Figures from the general ledger, by entry date. Contra lines (returns) appear as negatives inside their section.",
        },
      ],
    });
  },
};

const balanceSheet: TenantReport = {
  id: "balance-sheet",
  title: "Balance sheet",
  description: "Assets, liabilities and equity as at a date — asserted to balance.",
  category: "financial",
  roles: FINANCIAL_ROLES,
  sensitive: false,
  filters: [{ key: "asOf", label: "As at", type: "date", defaultHint: "today" }, comparativeFilter],
  async run(context, query) {
    const asOf = dateFilter(query, "asOf", "As at") ?? businessToday();
    const withComparative = textFilter(query, "comparative") !== "false";
    const s = await buildBalanceSheet(source(context), asOf, withComparative);
    return doc({
      reportId: "balance-sheet",
      title: "Balance sheet",
      brand: context.brand,
      period: { from: isoDay(asOf), to: isoDay(asOf) },
      filters: applied(["As at", isoDay(asOf)], ["Comparative", s.comparativeAsOf ? `as at ${isoDay(s.comparativeAsOf)}` : "Left out"]),
      sections: [
        {
          name: "Balance sheet",
          columns: STATEMENT_COLUMNS,
          rows: [
            ...lineRows("Current assets", s.assets.current, "Total current assets"),
            ...lineRows("Non-current assets", s.assets.nonCurrent, "Total non-current assets"),
            { part: "Assets", code: null, name: "Total assets", amount: s.assets.total.amount, comparative: s.assets.total.comparativeAmount },
            ...lineRows("Current liabilities", s.liabilities.current, "Total current liabilities"),
            ...lineRows("Long-term liabilities", s.liabilities.longTerm, "Total long-term liabilities"),
            { part: "Liabilities", code: null, name: "Total liabilities", amount: s.liabilities.total.amount, comparative: s.liabilities.total.comparativeAmount },
            ...lineRows("Equity", s.equity, "Total equity"),
            { part: "Liabilities and equity", code: null, name: "Total liabilities and equity", amount: s.liabilitiesAndEquity.amount, comparative: s.liabilitiesAndEquity.comparativeAmount },
          ],
          note: "The statement balances: total assets equal total liabilities and equity (asserted when it is built).",
        },
      ],
    });
  },
};

const cashFlow: TenantReport = {
  id: "cash-flow",
  title: "Cash flow statement",
  description: "Operating, investing and financing cash flows (indirect method), tied to the movement in cash.",
  category: "financial",
  roles: FINANCIAL_ROLES,
  sensitive: false,
  filters: [...PERIOD_FILTERS, comparativeFilter],
  async run(context, query) {
    const period = periodFilter(query);
    const s = await buildCashFlow(source(context), period, textFilter(query, "comparative") !== "false");
    const fig = (part: string, name: string, f: { amount: bigint; comparativeAmount: bigint | null }) => ({ part, code: null, name, amount: f.amount, comparative: f.comparativeAmount });
    return doc({
      reportId: "cash-flow",
      title: "Cash flow statement",
      brand: context.brand,
      period: periodOf(period),
      filters: applied(["Method", "Indirect"], ["Comparative", s.comparativePeriod ? `${isoDay(s.comparativePeriod.from)} to ${isoDay(s.comparativePeriod.to)}` : "Left out"]),
      sections: [
        {
          name: "Cash flow",
          columns: STATEMENT_COLUMNS,
          rows: [
            fig("Operating activities", "Net profit", s.netProfit),
            ...lineRows("Operating activities", s.nonCashAdjustments, "Total non-cash adjustments"),
            ...lineRows("Operating activities", s.workingCapitalChanges, "Total working-capital changes"),
            fig("Operating activities", "Net cash from operating activities", s.operatingActivities),
            ...lineRows("Investing activities", s.investingActivities, "Net cash from investing activities"),
            ...lineRows("Financing activities", s.financingActivities, "Net cash from financing activities"),
            fig("Cash", "Net change in cash", s.netChangeInCash),
            fig("Cash", "Opening cash and equivalents", s.openingCash),
            fig("Cash", "Closing cash and equivalents", s.closingCash),
          ],
        },
      ],
    });
  },
};

const trialBalance: TenantReport = {
  id: "trial-balance",
  title: "Trial balance",
  description: "Every account's debit or credit balance as at a date — debits equal credits.",
  category: "financial",
  roles: FINANCIAL_ROLES,
  sensitive: false,
  filters: [{ key: "asOf", label: "As at", type: "date", defaultHint: "today" }],
  async run(context, query) {
    const asOf = dateFilter(query, "asOf", "As at") ?? businessToday();
    const s = await buildTrialBalance(source(context), asOf, false);
    return doc({
      reportId: "trial-balance",
      title: "Trial balance",
      brand: context.brand,
      period: { from: isoDay(asOf), to: isoDay(asOf) },
      filters: applied(["As at", isoDay(asOf)]),
      sections: [
        {
          name: "Trial balance",
          columns: [
            { key: "code", header: "Account", kind: "text", width: 9 },
            { key: "name", header: "Name", kind: "text", width: 34 },
            { key: "class", header: "Class", kind: "text", width: 14 },
            { key: "debit", header: "Debit (KES)", kind: "money", total: true },
            { key: "credit", header: "Credit (KES)", kind: "money", total: true },
          ],
          rows: s.rows.map((r) => ({ code: r.code, name: r.name, class: r.accountClass.replace(/_/g, " ").toLowerCase(), debit: r.debit, credit: r.credit })),
        },
      ],
    });
  },
};

const vatReturn: TenantReport = {
  id: "vat-return",
  title: "VAT / Turnover Tax position",
  description: "Output and input VAT, sales by KRA code — or the Turnover Tax position for a TOT business.",
  category: "financial",
  roles: FINANCIAL_ROLES,
  sensitive: false,
  filters: PERIOD_FILTERS,
  async run(context, query) {
    const period = periodFilter(query);
    const r = await buildVatReturn(source(context), period);
    const line = (item: string, amount: bigint) => ({ item, amount });
    const rows =
      r.presentation === "VAT_RETURN"
        ? [
            line("Standard-rated sales (B)", r.vat.salesByCode.standardRated.turnover),
            line("VAT on standard-rated sales", r.vat.salesByCode.standardRated.vat),
            line("Zero-rated sales (C)", r.vat.salesByCode.zeroRated.turnover),
            line("Exempt sales (A)", r.vat.salesByCode.exempt.turnover),
            line("Output VAT, net", r.vat.outputVat.net),
            line("Taxable purchases", r.vat.taxablePurchases),
            line("Input VAT, net", r.vat.inputVat.net),
            line(`Net VAT (${r.vat.position.toLowerCase()})`, r.vat.netVat),
          ]
        : [line("Turnover", r.turnoverTax.turnover), line("Turnover Tax accrued", r.turnoverTax.accrued), line("Ledger movement on TOT payable", r.turnoverTax.ledgerMovement), line("TOT payable closing balance", r.turnoverTax.closingBalance)];
    return doc({
      reportId: "vat-return",
      title: r.presentation === "VAT_RETURN" ? "VAT return" : "Turnover Tax position",
      brand: context.brand,
      period: periodOf(period),
      filters: applied(["Tax regime", r.taxRegime.replace(/_/g, " ").toLowerCase()], ["TOT rate", r.presentation === "TOT_POSITION" && r.turnoverTax.ratePercent ? `${r.turnoverTax.ratePercent}%` : undefined]),
      sections: [
        { name: "Position", columns: [{ key: "item", header: "Item", kind: "text", width: 40 }, { key: "amount", header: "Amount (KES)", kind: "money" }], rows },
        ...(r.anomalies.length > 0 ? [{ name: "Anomalies", columns: [{ key: "code", header: "Code", kind: "text" as const, width: 30 }, { key: "message", header: "What it means", kind: "text" as const, width: 60 }, { key: "amount", header: "Amount (KES)", kind: "money" as const }], rows: r.anomalies.map((a) => ({ code: a.code, message: a.message, amount: a.amount })) }] : []),
      ],
    });
  },
};

const controlReconciliation: TenantReport = {
  id: "control-reconciliation",
  title: "Control-account reconciliation",
  description: "Inventory, receivables, payables and GRNI against their subledgers, with named reconciling items.",
  category: "financial",
  roles: FINANCIAL_ROLES,
  sensitive: false,
  filters: [],
  async run(context) {
    const r = await buildControlReconciliation(context.db, tenantSchemaFor(context.db));
    return doc({
      reportId: "control-reconciliation",
      title: "Control-account reconciliation",
      brand: context.brand,
      period: { from: isoDay(businessToday()), to: isoDay(businessToday()) },
      filters: applied(["Basis", "Current position"]),
      sections: [
        {
          name: "Controls",
          columns: [
            { key: "control", header: "Control", kind: "text", width: 22 },
            { key: "account", header: "Account", kind: "text", width: 9 },
            { key: "gl", header: "Ledger (KES)", kind: "money" },
            { key: "subledgerLabel", header: "Subledger", kind: "text", width: 26 },
            { key: "subledger", header: "Subledger (KES)", kind: "money" },
            { key: "residuals", header: "Reconciling items (KES)", kind: "money" },
            { key: "unexplained", header: "Unexplained (KES)", kind: "money" },
            { key: "ok", header: "Reconciles", kind: "text", width: 10 },
          ],
          rows: r.items.map((i) => ({ control: i.control.replace(/_/g, " ").toLowerCase(), account: i.accountCode, gl: i.glBalance, subledgerLabel: i.subledgerLabel, subledger: i.subledger, residuals: i.residuals.reduce((s, x) => s + x.amount, 0n), unexplained: i.unexplained, ok: i.reconciles ? "Yes" : "No" })),
        },
      ],
    });
  },
};

const monthlyTrend: TenantReport = {
  id: "monthly-trend",
  title: "Monthly trend",
  description: "Revenue, cost of sales, gross profit, expenses and net profit for each recent month.",
  category: "financial",
  roles: FINANCIAL_ROLES,
  sensitive: false,
  filters: [{ key: "months", label: "Months", type: "number", defaultHint: "12" }],
  async run(context, query) {
    const months = intFilter(query, "months", "Months", 2, 24, 12);
    const buckets = await buildDashboardTrend(context.db, months);
    return doc({
      reportId: "monthly-trend",
      title: "Monthly trend",
      brand: context.brand,
      period: buckets.length > 0 ? { from: buckets[0]?.from ?? "", to: buckets[buckets.length - 1]?.to ?? "" } : null,
      filters: applied(["Months", months.toString()]),
      sections: [
        {
          name: "Trend",
          note: "Each month is the income statement for that month; the current month is to date.",
          columns: [
            { key: "month", header: "Month", kind: "text", width: 10 },
            { key: "revenue", header: "Revenue (KES)", kind: "money", total: true },
            { key: "cost", header: "Cost of sales (KES)", kind: "money", total: true },
            { key: "gross", header: "Gross profit (KES)", kind: "money", total: true },
            { key: "expenses", header: "Expenses (KES)", kind: "money", total: true },
            { key: "net", header: "Net profit (KES)", kind: "money", total: true },
            { key: "partial", header: "", kind: "text", width: 9 },
          ],
          rows: buckets.map((b) => ({ month: b.month, revenue: b.revenue, cost: b.costOfSales, gross: b.grossProfit, expenses: b.operatingExpenses, net: b.netProfit, partial: b.partial ? "To date" : "" })),
        },
      ],
    });
  },
};

// ---- Payroll -----------------------------------------------------------------

const RUN_STATUSES = ["DRAFT", "APPROVED", "POSTED", "PAID", "CANCELLED"] as const;

const payrollRuns: TenantReport = {
  id: "payroll-runs",
  title: "Payroll runs",
  description: "Each payroll run with its gross, deductions and net pay.",
  category: "payroll",
  roles: PAYROLL_ROLES,
  sensitive: false,
  filters: [{ key: "year", label: "Year", type: "number" }, { key: "status", label: "Status", type: "select", options: RUN_STATUSES.map((s) => ({ value: s, label: s.toLowerCase() })) }],
  async run(context, query) {
    const yearText = textFilter(query, "year");
    const year = yearText === undefined ? undefined : intFilter(query, "year", "Year", 2000, 2100, 0);
    const status = enumFilter(query, "status", "Status", RUN_STATUSES);
    const runs = await listPayrollRuns(context.db, { ...(status ? { status } : {}), ...(year !== undefined ? { periodYear: year } : {}) });
    return doc({
      reportId: "payroll-runs",
      title: "Payroll runs",
      brand: context.brand,
      period: null,
      filters: applied(["Year", year?.toString()], ["Status", status?.toLowerCase()]),
      sections: [
        {
          name: "Runs",
          columns: [
            { key: "number", header: "Run", kind: "integer", width: 6 },
            { key: "period", header: "Month", kind: "text", width: 9 },
            { key: "status", header: "Status", kind: "text", width: 10 },
            { key: "payDate", header: "Pay date", kind: "date" },
            { key: "employees", header: "Employees", kind: "integer", total: true },
            { key: "gross", header: "Gross (KES)", kind: "money", total: true },
            { key: "deductions", header: "Deductions (KES)", kind: "money", total: true },
            { key: "net", header: "Net pay (KES)", kind: "money", total: true },
          ],
          rows: runs.map((r) => ({ number: BigInt(r.runNumber), period: `${r.periodYear.toString()}-${r.periodMonth.toString().padStart(2, "0")}`, status: r.status.toLowerCase(), payDate: isoDay(r.payDate), employees: BigInt(r.totals.employeeCount), gross: r.totals.grossPay, deductions: r.totals.grossPay - r.totals.netPay, net: r.totals.netPay })),
        },
      ],
    });
  },
};

async function runLabel(context: TenantContext, runId: string): Promise<string> {
  const run = await context.db.payrollRun.findUnique({ where: { id: runId }, select: { runNumber: true, periodYear: true, periodMonth: true } });
  if (run === null) throw new ReportFilterError("Choose a payroll run of this business.");
  return `Run ${run.runNumber.toString()} (${run.periodYear.toString()}-${run.periodMonth.toString().padStart(2, "0")})`;
}

const statutorySummary: TenantReport = {
  id: "payroll-statutory",
  title: "Payroll statutory schedules",
  description: "PAYE, NSSF, SHIF and the housing levy for a run — accrued, remitted and still owed, per head.",
  category: "payroll",
  roles: PAYROLL_ROLES,
  sensitive: true,
  filters: [{ key: "runId", label: "Payroll run", type: "entity", entity: "payrollRun", required: true }],
  async run(context, query) {
    const runId = textFilter(query, "runId");
    if (runId === undefined) throw new ReportFilterError("Choose a payroll run.");
    const label = await runLabel(context, runId);
    const s = await buildStatutorySummary(context.db, runId, context.businessName);
    if (s === null) throw new ReportFilterError("Choose a payroll run of this business.");
    const heads = [
      { name: "PAYE", tie: s.paye, rows: s.paye.rows.map((r) => ({ employee: r.employeeName, identifier: r.kraPin, gross: r.grossPay, amount: r.paye })) },
      { name: "NSSF", tie: s.nssf, rows: s.nssf.rows.map((r) => ({ employee: r.employeeName, identifier: r.nssfNumber, gross: r.grossPay, amount: r.total })) },
      { name: "SHIF", tie: s.shif, rows: s.shif.rows.map((r) => ({ employee: r.employeeName, identifier: r.shifNumber, gross: r.grossPay, amount: r.shif })) },
      { name: "Housing levy", tie: s.housingLevy, rows: s.housingLevy.rows.map((r) => ({ employee: r.employeeName, identifier: r.kraPin, gross: r.grossPay, amount: r.total })) },
    ];
    return doc({
      reportId: "payroll-statutory",
      title: "Payroll statutory schedules",
      brand: context.brand,
      period: null,
      filters: applied(["Payroll run", label]),
      sections: heads.map((head) => ({
        name: head.name,
        columns: [
          { key: "employee", header: "Employee", kind: "text" as const },
          { key: "identifier", header: "Identifier", kind: "text" as const, width: 16 },
          { key: "gross", header: "Gross (KES)", kind: "money" as const, total: true },
          { key: "amount", header: "Amount (KES)", kind: "money" as const, total: true },
        ],
        rows: head.rows,
        note: `${head.tie.authority}: remitted ${formatCentsKes(head.tie.remitted)}, outstanding ${head.tie.outstanding === null ? "not yet posted" : formatCentsKes(head.tie.outstanding)}. ${
          head.tie.missingIdentifiers.length === 0 ? "Fileable: every employee on it has the identifier." : `Not fileable yet — ${head.tie.missingIdentifiers.map((m) => `${m.employeeName} has no ${m.field === "kraPin" ? "KRA PIN" : m.field === "nssfNumber" ? "NSSF number" : "SHIF number"}`).join("; ")}.`
        }`,
      })),
    });
  },
};

const musterRoll: TenantReport = {
  id: "payroll-muster",
  title: "Payroll muster roll",
  description: "Every employee on a run: gross, each deduction and net pay. Employee-level and confidential.",
  category: "payroll",
  roles: PAYROLL_ROLES,
  sensitive: true,
  filters: [{ key: "runId", label: "Payroll run", type: "entity", entity: "payrollRun", required: true }],
  async run(context, query) {
    const runId = textFilter(query, "runId");
    if (runId === undefined) throw new ReportFilterError("Choose a payroll run.");
    const label = await runLabel(context, runId);
    const m = await buildMusterRoll(context.db, runId, context.businessName);
    if (m === null) throw new ReportFilterError("Choose a payroll run of this business.");
    return doc({
      reportId: "payroll-muster",
      title: "Payroll muster roll",
      brand: context.brand,
      period: null,
      filters: applied(["Payroll run", label], ["Confidential", "Employee pay — share only with those entitled to see it"]),
      sections: [
        {
          name: "Muster roll",
          columns: [
            { key: "employee", header: "Employee", kind: "text" },
            { key: "gross", header: "Gross (KES)", kind: "money", total: true },
            { key: "nssf", header: "NSSF (KES)", kind: "money", total: true },
            { key: "shif", header: "SHIF (KES)", kind: "money", total: true },
            { key: "ahl", header: "Housing levy (KES)", kind: "money", total: true },
            { key: "paye", header: "PAYE (KES)", kind: "money", total: true },
            { key: "net", header: "Net pay (KES)", kind: "money", total: true },
          ],
          rows: m.rows.map((r) => ({ employee: r.employeeName, gross: r.grossPay, nssf: r.nssf, shif: r.shif, ahl: r.housingLevy, paye: r.paye, net: r.netPay })),
        },
      ],
    });
  },
};

// ---- Integrations / external operations ------------------------------------

const externalOperations: TenantReport = {
  id: "external-operations",
  title: "M-Pesa and eTIMS operations",
  description: "M-Pesa prompts and KRA eTIMS invoices in the period, with any still pending or failed.",
  category: "integrations",
  roles: OPS_ROLES,
  sensitive: false,
  filters: [...PERIOD_FILTERS, { key: "outcome", label: "Show", type: "select", options: [{ value: "problems", label: "Pending or failed only" }] }],
  async run(context, query) {
    const period = periodFilter(query);
    const problems = textFilter(query, "outcome") === "problems";
    const { start, endExclusive: end } = businessWindow(period);
    const [pushes, invoices] = await Promise.all([
      context.db.mpesaTransaction.findMany({ where: { initiatedAt: { gte: start, lt: end }, ...(problems ? { status: { in: ["INITIATED", "CALLBACK_FAILED", "TIMED_OUT"] } } : {}) }, orderBy: [{ initiatedAt: "asc" }, { id: "asc" }], take: 50_001 }),
      context.db.etimsInvoice.findMany({ where: { createdAt: { gte: start, lt: end }, ...(problems ? { status: { in: ["PENDING", "QUEUED", "REJECTED", "FAILED"] } } : {}) }, include: { sale: { select: { saleNumber: true } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 50_001 }),
    ]);
    return doc({
      reportId: "external-operations",
      title: "M-Pesa and eTIMS operations",
      brand: context.brand,
      period: periodOf(period),
      filters: applied(["Show", problems ? "Pending or failed only" : "Everything"]),
      sections: [
        {
          name: "M-Pesa prompts",
          columns: [
            { key: "at", header: "Sent", kind: "datetime" },
            { key: "phone", header: "Phone", kind: "text", width: 14 },
            { key: "amount", header: "Amount (KES)", kind: "money", total: true },
            { key: "status", header: "Status", kind: "text", width: 16 },
            { key: "receipt", header: "M-Pesa receipt", kind: "text", width: 14 },
            { key: "result", header: "Result", kind: "text", width: 30 },
          ],
          rows: bounded(pushes, "M-Pesa prompts").map((p) => ({ at: p.initiatedAt, phone: p.phoneNumber.replace(/^(\d{3})\d+(\d{3})$/, "$1•••$2"), amount: p.amount, status: p.status.replace(/_/g, " ").toLowerCase(), receipt: p.mpesaReceiptNumber, result: p.resultDesc })),
          note: "Phone numbers are shortened: the report needs the outcome, not the customer's number.",
        },
        {
          name: "eTIMS invoices",
          columns: [
            { key: "at", header: "Created", kind: "datetime" },
            { key: "sale", header: "Sale", kind: "text", width: 22 },
            { key: "type", header: "Type", kind: "text", width: 11 },
            { key: "number", header: "Invoice no.", kind: "integer", width: 10 },
            { key: "status", header: "Status", kind: "text", width: 10 },
            { key: "attempts", header: "Retries", kind: "integer", width: 8 },
            { key: "message", header: "KRA says", kind: "text", width: 30 },
          ],
          rows: bounded(invoices, "eTIMS invoices").map((i) => ({ at: i.createdAt, sale: i.sale.saleNumber, type: i.invoiceType.replace(/_/g, " ").toLowerCase(), number: BigInt(i.etimsInvoiceNumber), status: i.status.toLowerCase(), attempts: BigInt(i.retryCount), message: i.resultMsg })),
        },
      ],
    });
  },
};

// ---- Mentorship & programmes, the owner's reciprocal view ------------------

const myMentorship: TenantReport = {
  id: "my-mentorship",
  title: "Mentoring and programmes",
  description: "Every mentorship engagement and programme membership on this business, and every read of its figures.",
  category: "mentorship",
  roles: [OWNER],
  sensitive: true,
  filters: [],
  async run(context) {
    const [engagements, memberships] = await Promise.all([
      platformDb.mentorshipEngagement.findMany({ where: { tenantId: context.tenantId }, include: { mentor: { select: { fullName: true } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
      platformDb.donorProjectMembership.findMany({ where: { tenantId: context.tenantId }, include: { project: { select: { name: true, donor: true, status: true } } }, orderBy: [{ joinedAt: "asc" }, { id: "asc" }] }),
    ]);
    const [mentorReads, programmeReads] = await Promise.all([
      platformDb.mentorshipAccessLog.findMany({ where: { tenantId: context.tenantId }, include: { mentor: { select: { fullName: true } } }, orderBy: [{ viewedAt: "desc" }, { id: "desc" }], take: 50_000 }),
      platformDb.donorAccessLog.findMany({ where: { tenantId: context.tenantId }, orderBy: [{ viewedAt: "desc" }, { id: "desc" }], take: 50_000 }),
    ]);
    return doc({
      reportId: "my-mentorship",
      title: "Mentoring and programmes",
      brand: context.brand,
      period: null,
      filters: [],
      sections: [
        {
          name: "Engagements",
          columns: [
            { key: "mentor", header: "Mentor", kind: "text" },
            { key: "status", header: "Status", kind: "text", width: 10 },
            { key: "consentAt", header: "You consented", kind: "datetime" },
            { key: "endedAt", header: "Ended", kind: "datetime" },
          ],
          rows: engagements.map((e) => ({ mentor: e.mentor.fullName, status: e.status.toLowerCase(), consentAt: e.consentGivenAt, endedAt: e.endedAt })),
        },
        {
          name: "Programmes",
          columns: [
            { key: "project", header: "Programme", kind: "text" },
            { key: "donor", header: "Donor", kind: "text", width: 20 },
            { key: "consent", header: "Your consent", kind: "text", width: 12 },
            { key: "since", header: "Joined", kind: "datetime" },
          ],
          rows: memberships.map((m) => ({ project: m.project.name, donor: m.project.donor, consent: m.consentStatus.toLowerCase(), since: m.joinedAt })),
        },
        {
          name: "Reads of your figures",
          columns: [
            { key: "at", header: "When", kind: "datetime" },
            { key: "who", header: "Who", kind: "text", width: 24 },
            { key: "what", header: "What was read", kind: "text", width: 40 },
          ],
          rows: [
            ...mentorReads.map((r) => ({ at: r.viewedAt, who: `${r.mentor.fullName} (mentor)`, what: r.resource })),
            ...programmeReads.map((r) => ({ at: r.viewedAt, who: "Programme staff", what: r.resource })),
          ].sort((a, b) => b.at.getTime() - a.at.getTime()),
        },
      ],
    });
  },
};

export const TENANT_REPORTS: readonly TenantReport[] = [
  sales,
  topProducts,
  stockLevels,
  stockMovements,
  allocations,
  purchaseOrders,
  suppliers,
  customers,
  receivablesAging,
  payablesAging,
  supplierBills,
  customerReceipts,
  expenses,
  incomeStatement,
  balanceSheet,
  cashFlow,
  trialBalance,
  vatReturn,
  controlReconciliation,
  monthlyTrend,
  payrollRuns,
  statutorySummary,
  musterRoll,
  externalOperations,
  myMentorship,
];
