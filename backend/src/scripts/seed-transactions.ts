// Seeds REALISTIC TRADING HISTORY into the nakuru-hardware DEVELOPMENT tenant, so the
// dashboard is built and tested against real figures. DEV-ONLY.
//
// Usage: npm run seed:transactions        (after seed:users; the backend need not be running)
//
// EVERYTHING GOES THROUGH THE BACKEND'S OWN SERVICES — the same entry points the API uses —
// never a raw GL or table insert, so every figure flows through the double-entry ledger
// exactly as it would in production:
//   * products and the customer/supplier are created the way their routes create them;
//   * the shop sells from ONE counter till — a permanent, offline-capable POS location (its
//     lease never expires) with a registered device — which owns all the stock, so MAIN holds
//     none and raises no false low-stock alert;
//   * opening stock is the inventory service's OPENING_BALANCE movement (Dr 1200 / Cr 3000), at
//     the till;
//   * RESTOCKING is the full procure-to-pay cycle, monthly per supplier: a purchase order,
//     approved and RECEIVED at the till (Dr 1200 / Cr 2050 GRNI), the supplier's BILL posted
//     (Dr 2050 / Cr 2000 Accounts Payable) and PAID from the bank (Dr 2000 / Cr 1020) — the
//     older months in full, last month's partly (an overdue balance), this month's not yet;
//   * HISTORY is delivered through the OFFLINE SYNC INGEST, the only path on which a sale
//     carries its real `businessTimestamp`: the journal entry is dated to it AND the AR aging,
//     the sale lists and the receipts read it. (Backdating an online sale's entryDate would
//     move the ledger but leave createdAt = now everywhere else.) Historical tenders are CASH
//     and CREDIT — an M-Pesa STK payment needs the till online at the moment of payment;
//   * TODAY's sales go through the ONLINE path (recordSale), and their M-Pesa tenders through
//     the STK flow and the SIMULATED provider's callback (1015 -> 1010);
//   * the history is rung on one shift, which is then CLOSED with the drawer counted exactly
//     (no variance); today's sales are on a fresh shift, left open (the shop is trading);
//   * the till's cash is BANKED weekly (Dr 1020 / Cr 1000, through the ledger service), so cash
//     on hand stays a working float rather than four months of takings;
//   * one sale from last month is VOIDED today (voids are dated the day they happen), so the
//     trend shows a void reducing the month it is posted in;
//   * expenses through recordExpense; SALARIES through a real payroll run and net-pay
//     settlement (6020 / 6025 may not be charged as an expense — they tie to payslips);
//   * the owner's opening capital to the bank through the ledger service.
//
// IDEMPOTENT AND RESUMABLE: every record carries a `seed:tx:*` reference (or a unique name /
// SKU / code / payroll month, or a sync idempotency key) and is skipped if it already exists,
// so a re-run adds nothing and a run interrupted part-way finishes the rest. Opening stock is
// computed from the (deterministic) plan, so every product ends where it is meant to: the tap
// and the wheelbarrow below their reorder level, the rest comfortably above.
//
// Dates are RELATIVE to today (the last four business months, the current one to date), so
// the history always ends now. Nothing is posted into a closed period — a closed period makes
// the run fail loudly rather than skip.
//
// eTIMS IS DELIBERATELY LEFT UNCONFIGURED (no sale requests a fiscal invoice), so the
// dashboard's eTIMS card is correctly absent. To demo it: `npm run seed:credentials` (stores
// SANDBOX M-Pesa + eTIMS credentials), initialise the device (POST /v1/etims/device/initialize)
// and ring sales with `requestEtims: true`.
//
// The tenant is on TURNOVER_TAX (as provisioned), so sales charge no VAT and accrue 3% TOT.

import { resolveTenantContext } from "../auth/tenant-registry";
import { env } from "../config/env";
import { platformDb } from "../db/platform";
import { closePool } from "../db/pool";
import { disconnectAllTenantDbs, getTenantDb } from "../db/tenant";
import type { PrismaClient as TenantPrismaClient } from "../generated/tenant/client";
import type { TaxClass } from "../generated/tenant/enums";
import { businessToday } from "../lib/business-time";
import type { Cents } from "../lib/money";
import { recordExpense } from "../services/expenses";
import { recordStockMovement } from "../services/inventory";
import { createSupplierBill, postSupplierBill, recordSupplierPayment } from "../services/payables";
import { approvePurchaseOrder, createPurchaseOrder, receivePurchaseOrder } from "../services/procurement";
import { postJournalEntry } from "../services/ledger";
import { createLocation } from "../services/locations";
import { buildSimulatedCallbackEnvelope } from "../services/mpesa/simulated-provider";
import { handleCallback, initiateStkPushForTender } from "../services/mpesa/payment";
import { registerDevice, startLease } from "../services/offline/custody";
import { ingestSyncBatch, type CapturedSaleInput } from "../services/offline/sync";
import { approvePayrollRun, createEmployee, createPayrollRun, postPayrollRun } from "../services/payroll";
import { settleNetPay } from "../services/payroll-settlement";
import { recordSale, voidSale, type SaleLineInput } from "../services/sales";
import { closeShift, getShiftSummary, openShift } from "../services/shifts";

const SUBDOMAIN = "nakuru-hardware";
const OWNER_EMAIL = "owner@nakuru-hardware.co.ke";
const CASHIER_EMAIL = "cashier@nakuru-hardware.co.ke";
const TAG = "seed:tx";
const MPESA_PHONE = "254712345678";

// ---- Dates (relative to today, Africa/Nairobi business days) ----------------------------

const today = businessToday();
const todayIndex = today.getUTCFullYear() * 12 + today.getUTCMonth();

/** [year, month 1–12] of the month `back` months ago. */
function monthOf(back: number): [number, number] {
  const index = todayIndex - back;
  return [Math.floor(index / 12), (index % 12) + 1];
}

/** Days in that month — for the current month, the days so far (today included). */
function daysIn(back: number): number {
  if (back === 0) return today.getUTCDate();
  const [year, month] = monthOf(back);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The business DATE (00:00 UTC) of day `day` in the month `back` months ago — clamped to today. */
function dateOf(back: number, day: number): Date {
  const [year, month] = monthOf(back);
  return new Date(Date.UTC(year, month - 1, Math.min(day, daysIn(back))));
}

/** An INSTANT on that business day: 09:00 Nairobi (06:00 UTC) plus `minutes`. */
function instantOf(back: number, day: number, minutes = 0): Date {
  return new Date(dateOf(back, day).getTime() + (6 * 60 + minutes) * 60_000);
}

const shillings = (amount: number): Cents => BigInt(Math.round(amount * 100));
const decimal = (cents: Cents): string => `${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, "0")}`;

// ---- The catalogue ------------------------------------------------------------------------

interface ProductSeed {
  sku: string;
  name: string;
  category: string;
  unit: string;
  price: number; // KES
  cost: number; // KES (GOODs)
  kind: "GOOD" | "SERVICE";
  taxClass: TaxClass;
  /** GOODs: the quantity the till should hold once the plan has run. */
  endQty?: number;
  reorderAt?: number;
}

const PRODUCTS: readonly ProductSeed[] = [
  { sku: "NKH-CEM-50", name: "Bamburi Cement 50kg", category: "Building materials", unit: "bag", price: 850, cost: 690, kind: "GOOD", taxClass: "STANDARD_RATED", endQty: 140, reorderAt: 40 },
  { sku: "NKH-IRS-30", name: "Iron Sheet 30 Gauge 3m", category: "Roofing", unit: "sheet", price: 1250, cost: 900, kind: "GOOD", taxClass: "STANDARD_RATED", endQty: 85, reorderAt: 20 },
  { sku: "NKH-NAI-4", name: "Wire Nails 4in (1kg)", category: "Fasteners", unit: "kg", price: 220, cost: 140, kind: "GOOD", taxClass: "STANDARD_RATED", endQty: 180, reorderAt: 30 },
  { sku: "NKH-PNT-4L", name: "Crown Emulsion Paint 4L", category: "Paint", unit: "tin", price: 2400, cost: 1650, kind: "GOOD", taxClass: "STANDARD_RATED", endQty: 30, reorderAt: 8 },
  { sku: "NKH-PVC-20", name: "PVC Pipe 20mm x 6m", category: "Plumbing", unit: "length", price: 380, cost: 240, kind: "GOOD", taxClass: "STANDARD_RATED", endQty: 120, reorderAt: 20 },
  { sku: "NKH-BAR-12", name: "Y12 Steel Bar 12m", category: "Steel", unit: "bar", price: 1100, cost: 820, kind: "GOOD", taxClass: "STANDARD_RATED", endQty: 90, reorderAt: 15 },
  // These two end below their reorder level (the low-stock signal).
  { sku: "NKH-TAP-15", name: "Brass Tap 15mm", category: "Plumbing", unit: "piece", price: 650, cost: 380, kind: "GOOD", taxClass: "STANDARD_RATED", endQty: 4, reorderAt: 10 },
  { sku: "NKH-WHB-HD", name: "Wheelbarrow (Heavy Duty)", category: "Tools", unit: "piece", price: 6500, cost: 4800, kind: "GOOD", taxClass: "STANDARD_RATED", endQty: 2, reorderAt: 5 },
  { sku: "NKH-SVC-DEL", name: "Delivery within Nakuru", category: "Services", unit: "trip", price: 500, cost: 0, kind: "SERVICE", taxClass: "STANDARD_RATED" },
  { sku: "NKH-SVC-CUT", name: "Steel Cutting & Bending", category: "Services", unit: "job", price: 800, cost: 0, kind: "SERVICE", taxClass: "STANDARD_RATED" },
  { sku: "NKH-SVC-PLB", name: "Plumbing Installation (per point)", category: "Services", unit: "point", price: 1500, cost: 0, kind: "SERVICE", taxClass: "STANDARD_RATED" },
];

/** Who supplies what (the tap and the wheelbarrow are never restocked: they end low). */
const SUPPLIERS = [
  { key: "BAM", name: "Bamburi Distributors Ltd", phone: "254733000222", skus: ["NKH-CEM-50"] },
  {
    key: "RVW",
    name: "Rift Valley Hardware Wholesalers",
    phone: "254733000333",
    skus: ["NKH-IRS-30", "NKH-NAI-4", "NKH-PNT-4L", "NKH-PVC-20", "NKH-BAR-12"],
  },
] as const;
type SupplierKey = (typeof SUPPLIERS)[number]["key"];
/** The purchasing calendar: ordered on the 3rd, received on the 6th, billed on the 7th. */
const PO_DAY = 3;
const RECEIVE_DAY = 6;
const BILL_DAY = 7;

// ---- The trading plan (deterministic) -------------------------------------------------------

type Tender = "CASH" | "MPESA" | "CREDIT";
interface PlannedLine {
  sku: string;
  qty: number;
  discountPct?: number;
}
interface PlannedSale {
  key: string;
  back: number;
  day: number;
  minutes: number;
  lines: PlannedLine[];
  tender: Tender;
  /** Rung TODAY through the online path (M-Pesa STK possible); otherwise captured and synced. */
  online?: boolean;
  voidToday?: boolean;
}

/** A small deterministic generator, so the plan is the same on every run. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const EVERYDAY: ReadonlyArray<{ sku: string; min: number; max: number }> = [
  { sku: "NKH-CEM-50", min: 3, max: 15 },
  { sku: "NKH-IRS-30", min: 2, max: 12 },
  { sku: "NKH-NAI-4", min: 2, max: 10 },
  { sku: "NKH-PNT-4L", min: 1, max: 4 },
  { sku: "NKH-PVC-20", min: 2, max: 10 },
  { sku: "NKH-BAR-12", min: 2, max: 10 },
];
const SERVICES = ["NKH-SVC-DEL", "NKH-SVC-CUT", "NKH-SVC-PLB"] as const;

function plan(): PlannedSale[] {
  const random = lcg(2026);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)] as T;
  const lineSet = (i: number): PlannedLine[] => {
    const lineCount = 1 + Math.floor(random() * 3);
    const lines: PlannedLine[] = [];
    const used = new Set<string>();
    while (lines.length < lineCount) {
      const item = pick(EVERYDAY);
      if (used.has(item.sku)) continue;
      used.add(item.sku);
      lines.push({ sku: item.sku, qty: item.min + Math.floor(random() * (item.max - item.min + 1)) });
    }
    if (i % 4 === 1) lines.push({ sku: pick(SERVICES), qty: 1 });
    const first = lines[0];
    if (i % 5 === 2 && first !== undefined) first.discountPct = 5;
    return lines;
  };

  const sales: PlannedSale[] = [];
  // Captured sales per month, oldest first — a growing business. The current month's are
  // spread over the days BEFORE today; today's are rung online below.
  const capturedDays = (back: number) => (back === 0 ? daysIn(0) - 1 : daysIn(back));
  const volume: Array<[number, number]> = [
    [3, 34],
    [2, 44],
    [1, 55],
    [0, Math.round((55 * capturedDays(0)) / 31)],
  ];
  for (const [back, count] of volume) {
    const days = capturedDays(back);
    if (days < 1) continue;
    for (let i = 0; i < count; i += 1) {
      sales.push({
        key: `m${back.toString()}-${String(i + 1).padStart(2, "0")}`,
        back,
        day: 1 + Math.floor((i * days) / count),
        minutes: 25 * (i % 16),
        lines: lineSet(i),
        tender: "CASH",
        // One of last month's sales is voided today: the void reduces THIS month.
        voidToday: back === 1 && i === 3,
      });
    }
  }
  // Fixed sales: the two items that end below their reorder level, and two overdue credit sales.
  sales.push(
    { key: "tap-1", back: 2, day: 9, minutes: 300, lines: [{ sku: "NKH-TAP-15", qty: 2 }, { sku: "NKH-SVC-PLB", qty: 2 }], tender: "CASH" },
    { key: "tap-2", back: 1, day: 18, minutes: 300, lines: [{ sku: "NKH-TAP-15", qty: 3 }], tender: "CASH" },
    { key: "whb-1", back: 2, day: 21, minutes: 360, lines: [{ sku: "NKH-WHB-HD", qty: 1 }], tender: "CASH" },
    { key: "whb-2", back: 1, day: 25, minutes: 360, lines: [{ sku: "NKH-WHB-HD", qty: 2 }, { sku: "NKH-SVC-DEL", qty: 1 }], tender: "CASH" },
    // ~2 months old and unpaid: overdue.
    { key: "credit-1", back: 2, day: 5, minutes: 120, lines: [{ sku: "NKH-CEM-50", qty: 20 }, { sku: "NKH-IRS-30", qty: 10 }, { sku: "NKH-SVC-DEL", qty: 1 }], tender: "CREDIT" },
    // ~5 weeks old: overdue too.
    { key: "credit-2", back: 1, day: Math.max(1, daysIn(1) - 4), minutes: 120, lines: [{ sku: "NKH-BAR-12", qty: 12 }, { sku: "NKH-SVC-CUT", qty: 2 }], tender: "CREDIT" },
  );
  // Today, online: cash and M-Pesa (STK), and one current credit sale.
  for (let i = 0; i < 6; i += 1) {
    sales.push({
      key: `today-${String(i + 1).padStart(2, "0")}`,
      back: 0,
      day: daysIn(0),
      minutes: 0,
      lines: lineSet(i),
      tender: i % 2 === 0 ? "MPESA" : "CASH",
      online: true,
    });
  }
  sales.push({
    key: "today-credit",
    back: 0,
    day: daysIn(0),
    minutes: 0,
    lines: [
      { sku: "NKH-PNT-4L", qty: 3 },
      { sku: "NKH-SVC-DEL", qty: 1 },
    ],
    tender: "CREDIT",
    online: true,
  });
  return sales;
}

interface Restock {
  back: number;
  supplier: SupplierKey;
  lines: Array<{ sku: string; qty: number }>;
}

/**
 * The monthly restock: each month's purchase order replaces what that month sells, so the
 * shelves stay steady. A month whose receiving day has not come yet orders nothing.
 */
function plannedRestocks(sales: readonly PlannedSale[]): Restock[] {
  const restocks: Restock[] = [];
  for (const back of [3, 2, 1, 0]) {
    if (back === 0 && daysIn(0) <= RECEIVE_DAY) continue;
    for (const supplier of SUPPLIERS) {
      const lines = supplier.skus
        .map((sku) => ({
          sku,
          qty: sales
            .filter((sale) => sale.back === back && sale.voidToday !== true)
            .flatMap((sale) => sale.lines)
            .filter((line) => line.sku === sku)
            .reduce((total, line) => total + line.qty, 0),
        }))
        .filter((line) => line.qty > 0);
      if (lines.length > 0) restocks.push({ back, supplier: supplier.key, lines });
    }
  }
  return restocks;
}

/** Net quantity of each SKU the plan sells (a voided sale returns its goods). */
function plannedNetSold(sales: readonly PlannedSale[]): Map<string, number> {
  const sold = new Map<string, number>();
  for (const sale of sales) {
    if (sale.voidToday === true) continue;
    for (const line of sale.lines) sold.set(line.sku, (sold.get(line.sku) ?? 0) + line.qty);
  }
  return sold;
}

// ---- Steps ------------------------------------------------------------------------------------

interface Ctx {
  db: TenantPrismaClient;
  ownerId: string;
  cashierId: string;
  products: Map<string, { id: string; price: Cents }>;
  netSold: Map<string, number>;
  restocks: Restock[];
  customerId: string;
  tillId: string;
  shiftId: string | null;
  counts: Record<string, number>;
}

function bump(ctx: Ctx, what: string, by = 1): void {
  ctx.counts[what] = (ctx.counts[what] ?? 0) + by;
}

async function seedCapital(ctx: Ctx): Promise<void> {
  const reference = `${TAG}:capital`;
  if ((await ctx.db.journalEntry.count({ where: { reference } })) > 0) return;
  await postJournalEntry(ctx.db, {
    entryDate: dateOf(3, 1),
    description: "Owner's capital deposited to the business bank account (dev seed)",
    reference,
    source: "MANUAL",
    createdBy: ctx.ownerId,
    lines: [
      { accountCode: "1020", debit: shillings(450_000) },
      { accountCode: "3000", credit: shillings(450_000) },
    ],
  });
  bump(ctx, "capital entry");
}

/** The shop counter: a permanent POS till (offline-capable, a lease that never expires) and its device. */
async function seedTill(ctx: Ctx): Promise<string> {
  const code = "TILL-1";
  const till =
    (await ctx.db.location.findFirst({ where: { code } })) ??
    (await createLocation(ctx.db, { name: "Shop Counter (Till 1)", code, type: "POS", isOfflineCapable: true, leaseWindowMinutes: null }));
  ctx.tillId = till.id;
  const deviceName = "Counter tablet";
  let device = await ctx.db.posDevice.findFirst({ where: { deviceName } });
  if (device === null) {
    const registered = await registerDevice(ctx.db, { deviceName, locationId: till.id, registeredBy: ctx.ownerId });
    device = await ctx.db.posDevice.findUniqueOrThrow({ where: { id: registered.id } });
    bump(ctx, "till device");
  }
  if (device.leaseStartedAt === null) await startLease(ctx.db, device.id);
  return device.id;
}

async function seedProducts(ctx: Ctx): Promise<void> {
  for (const seed of PRODUCTS) {
    let product = await ctx.db.product.findUnique({ where: { sku: seed.sku } });
    if (product === null) {
      product = await ctx.db.product.create({
        data: {
          sku: seed.sku,
          name: seed.name,
          category: seed.category,
          unitOfMeasure: seed.unit,
          price: shillings(seed.price),
          costPrice: shillings(seed.cost),
          kind: seed.kind,
          taxClass: seed.taxClass,
          minStockThreshold: seed.reorderAt ?? 0,
        },
      });
      bump(ctx, "product");
    }
    ctx.products.set(seed.sku, { id: product.id, price: product.price });
    if (seed.kind === "GOOD" && seed.endQty !== undefined) {
      const reference = `${TAG}:opening:${seed.sku}`;
      if ((await ctx.db.stockMovement.count({ where: { reference } })) === 0) {
        const restocked = ctx.restocks.flatMap((r) => r.lines).filter((l) => l.sku === seed.sku).reduce((t, l) => t + l.qty, 0);
        const opening = seed.endQty + (ctx.netSold.get(seed.sku) ?? 0) - restocked;
        if (opening <= 0) throw new Error(`The plan sells more ${seed.sku} than it can stock.`);
        await recordStockMovement(ctx.db, {
          productId: product.id,
          movementType: "OPENING_BALANCE",
          quantity: opening.toString(),
          unitCost: shillings(seed.cost),
          reference,
          notes: "Opening stock (dev seed)",
          createdBy: ctx.ownerId,
          entryDate: dateOf(3, 1),
          locationId: ctx.tillId,
        });
        bump(ctx, "opening stock");
      }
    }
  }
}

async function seedPartners(ctx: Ctx): Promise<Map<SupplierKey, string>> {
  const customerName = "Kiptoo Construction Ltd";
  const customer =
    (await ctx.db.customer.findFirst({ where: { name: customerName } })) ??
    (await ctx.db.customer.create({ data: { name: customerName, phone: "254722000111", creditLimit: shillings(150_000) } }));
  ctx.customerId = customer.id;

  const suppliers = new Map<SupplierKey, string>();
  for (const seed of SUPPLIERS) {
    const supplier =
      (await ctx.db.supplier.findFirst({ where: { name: seed.name } })) ??
      (await ctx.db.supplier.create({ data: { name: seed.name, phone: seed.phone, paymentTerms: "Net 30" } }));
    suppliers.set(seed.key, supplier.id);
  }
  return suppliers;
}

/**
 * Procure-to-pay, month by month: PO -> approve -> receive at the till -> post the supplier's
 * bill -> pay it from the bank. The two oldest months are paid in full; last month's
 * wholesaler bill is paid HALF (an overdue balance once its 30 days pass); this month's bills
 * are not yet due and stay unpaid.
 */
async function seedPurchasing(ctx: Ctx, suppliers: Map<SupplierKey, string>): Promise<void> {
  for (const restock of ctx.restocks) {
    const supplierId = suppliers.get(restock.supplier);
    if (supplierId === undefined) throw new Error(`No supplier ${restock.supplier}.`);
    const [year, month] = monthOf(restock.back);
    const period = `${year.toString()}${String(month).padStart(2, "0")}`;
    const poKey = `${TAG}:po:${restock.supplier}:${period}`;

    let po = await ctx.db.purchaseOrder.findFirst({ where: { notes: poKey }, include: { lines: true } });
    if (po === null) {
      const draft = await createPurchaseOrder(ctx.db, {
        supplierId,
        orderDate: dateOf(restock.back, PO_DAY),
        expectedDate: dateOf(restock.back, RECEIVE_DAY),
        notes: poKey,
        lines: restock.lines.map((line) => {
          const product = PRODUCTS.find((p) => p.sku === line.sku);
          const id = ctx.products.get(line.sku)?.id;
          if (product === undefined || id === undefined) throw new Error(`Unknown SKU ${line.sku}.`);
          return { productId: id, quantity: line.qty.toString(), unitCost: shillings(product.cost) };
        }),
        createdById: ctx.ownerId,
      });
      await approvePurchaseOrder(ctx.db, draft.id, ctx.ownerId);
      po = await ctx.db.purchaseOrder.findUniqueOrThrow({ where: { id: draft.id }, include: { lines: true } });
      bump(ctx, "purchase order");
    }
    if (po.status === "APPROVED") {
      await receivePurchaseOrder(ctx.db, po.id, {
        lines: po.lines.map((line) => ({ purchaseOrderLineId: line.id, quantity: line.orderedQty.toString() })),
        receivingLocationId: ctx.tillId,
        receivedById: ctx.ownerId,
        receivedAt: instantOf(restock.back, RECEIVE_DAY),
      });
      bump(ctx, "goods receipt");
    }

    const billNumber = `INV-${restock.supplier}-${period}`;
    let bill = await ctx.db.supplierBill.findFirst({ where: { supplierId, billNumber } });
    if (bill === null) {
      const created = await createSupplierBill(ctx.db, {
        supplierId,
        billNumber,
        poId: po.id,
        billDate: dateOf(restock.back, BILL_DAY),
        createdById: ctx.ownerId,
        lines: po.lines.map((line) => ({
          description: `PO ${po?.poNumber.toString() ?? ""} line`,
          quantity: line.orderedQty.toString(),
          unitCost: line.unitCost,
          purchaseOrderLineId: line.id,
        })),
      });
      bill = await ctx.db.supplierBill.findUniqueOrThrow({ where: { id: created.id } });
      bump(ctx, "supplier bill");
    }
    if (bill.status === "DRAFT") {
      await postSupplierBill(ctx.db, bill.id, ctx.ownerId);
      bill = await ctx.db.supplierBill.findUniqueOrThrow({ where: { id: bill.id } });
    }

    // Payment: in full for the older months; half of last month's wholesaler bill; none this month.
    const share = restock.back >= 2 ? 100n : restock.back === 1 ? (restock.supplier === "RVW" ? 50n : 100n) : 0n;
    const payReference = `${TAG}:pay:${billNumber}`;
    if (share > 0n && (await ctx.db.supplierPayment.count({ where: { reference: payReference } })) === 0) {
      const amount = (((bill.total * share) / 100n) / 100n) * 100n; // whole shillings
      await recordSupplierPayment(ctx.db, {
        supplierId,
        paymentDate: dateOf(restock.back, BILL_DAY + 20),
        method: "BANK",
        amount,
        reference: payReference,
        allocations: [{ billId: bill.id, amount }],
        createdById: ctx.ownerId,
      });
      bump(ctx, "supplier payment");
    }
  }
}

async function shiftFor(ctx: Ctx): Promise<string> {
  if (ctx.shiftId !== null) return ctx.shiftId;
  const open = await ctx.db.shift.findFirst({ where: { cashierId: ctx.cashierId, status: "OPEN" } });
  ctx.shiftId = open?.id ?? (await openShift(ctx.db, ctx.cashierId, shillings(5_000))).id;
  return ctx.shiftId;
}

function linesOf(ctx: Ctx, planned: PlannedSale): { lines: SaleLineInput[]; total: Cents } {
  let total = 0n;
  const lines: SaleLineInput[] = planned.lines.map((line) => {
    const product = ctx.products.get(line.sku);
    if (product === undefined) throw new Error(`Unknown SKU ${line.sku} in the plan.`);
    const gross = product.price * BigInt(line.qty);
    // A discount in whole shillings, so an M-Pesa total stays in whole shillings.
    const discount = line.discountPct === undefined ? 0n : ((gross * BigInt(line.discountPct)) / 10_000n) * 100n;
    total += gross - discount;
    return { productId: product.id, quantity: line.qty.toString(), ...(discount > 0n ? { discount: decimal(discount) } : {}) };
  });
  return { lines, total };
}

/** History, through the offline sync ingest — each sale dated to its real businessTimestamp. */
async function syncHistory(ctx: Ctx, deviceId: string, sales: readonly PlannedSale[]): Promise<void> {
  // Already synced and its shift closed: a replay would be refused by the closed shift, and it
  // would add nothing anyway (every key is consumed).
  const done = await ctx.db.capturedSale.count({ where: { idempotencyKey: { startsWith: `${TAG}:` }, status: "POSTED" } });
  if (done >= sales.length) return;
  const shiftId = await shiftFor(ctx);
  const captures: CapturedSaleInput[] = sales.map((planned) => {
    const { lines, total } = linesOf(ctx, planned);
    return {
      idempotencyKey: `${TAG}:${planned.key}`,
      businessTimestamp: instantOf(planned.back, planned.day, planned.minutes),
      shiftId,
      reference: `${TAG}:sale:${planned.key}`,
      lines,
      tenders: [{ tenderType: planned.tender, amount: decimal(total) }],
      ...(planned.tender === "CREDIT" ? { customerId: ctx.customerId } : {}),
    };
  });
  // The device delivers its whole outbox in one batch; a replayed key is a no-op.
  const result = await ingestSyncBatch(ctx.db, { deviceId, sales: captures, syncedBy: ctx.ownerId });
  if (result.summary.posted > 0) bump(ctx, "synced sale", result.summary.posted);
  const stuck = result.results.filter((outcome) => outcome.outcome === "NEEDS_RESOLUTION");
  if (stuck.length > 0) {
    throw new Error(`${stuck.length.toString()} capture(s) did not post: ${stuck.map((o) => `${o.idempotencyKey}: ${o.reason ?? "no reason"}`).join("; ")}`);
  }
  // Close the history's shift with the drawer counted exactly: float + the cash it took.
  const summary = await getShiftSummary(ctx.db, shiftId);
  if (summary === null) throw new Error(`Shift ${shiftId} vanished.`);
  await closeShift(ctx.db, shiftId, summary.openingFloat + summary.tenderBreakdown.CASH, ctx.cashierId);
  ctx.shiftId = null;
  bump(ctx, "closed history shift");
}

/**
 * Weekly banking of the till's cash takings (Dr 1020 Bank / Cr 1000 Cash), through the ledger
 * service: 95% of each week's captured cash sales, rounded down to KES 100, banked on the week's
 * last day — never today or later (this week's takings are still in the drawer).
 */
async function seedBanking(ctx: Ctx, sales: readonly PlannedSale[]): Promise<void> {
  const weeks = new Map<string, { back: number; day: number; cash: Cents }>();
  for (const planned of sales) {
    if (planned.online === true || planned.tender !== "CASH") continue;
    const week = Math.floor((planned.day - 1) / 7);
    const key = `m${planned.back.toString()}-w${(week + 1).toString()}`;
    const bankDay = Math.min(week * 7 + 7, planned.back === 0 ? daysIn(0) : daysIn(planned.back));
    const entry = weeks.get(key) ?? { back: planned.back, day: bankDay, cash: 0n };
    entry.cash += linesOf(ctx, planned).total;
    weeks.set(key, entry);
  }
  for (const [key, week] of weeks) {
    if (week.back === 0 && week.day >= daysIn(0)) continue;
    const reference = `${TAG}:bank:${key}`;
    if ((await ctx.db.journalEntry.count({ where: { reference } })) > 0) continue;
    const amount = ((week.cash * 95n) / 100n / 10_000n) * 10_000n;
    if (amount <= 0n) continue;
    await postJournalEntry(ctx.db, {
      entryDate: dateOf(week.back, week.day),
      description: "Cash takings banked (dev seed)",
      reference,
      source: "MANUAL",
      createdBy: ctx.ownerId,
      lines: [
        { accountCode: "1020", debit: amount },
        { accountCode: "1000", credit: amount },
      ],
    });
    bump(ctx, "bank deposit");
  }
}

async function confirmMpesa(ctx: Ctx, saleId: string): Promise<void> {
  const tender = await ctx.db.saleTender.findFirst({ where: { saleId, tenderType: "MPESA", status: "PENDING", mpesaTransactionId: null } });
  if (tender === null) return;
  const tenantRow = await platformDb.tenant.findUniqueOrThrow({ where: { subdomain: SUBDOMAIN } });
  const tenant = await resolveTenantContext(tenantRow.id);
  const push = await initiateStkPushForTender(ctx.db, {
    saleId,
    tenderId: tender.id,
    phoneNumber: MPESA_PHONE,
    createdBy: ctx.cashierId,
    tenant,
  });
  const txn = await ctx.db.mpesaTransaction.findUniqueOrThrow({ where: { checkoutRequestId: push.checkoutRequestId } });
  const envelope = buildSimulatedCallbackEnvelope(
    { merchantRequestId: txn.merchantRequestId, checkoutRequestId: txn.checkoutRequestId, amountCents: txn.amount, phoneNumber: txn.phoneNumber },
    "success",
  );
  const result = await handleCallback({ rawBody: envelope, headers: {}, pathSecret: env.mpesa.callbackPathSecret, tenantSlug: SUBDOMAIN, sourceIp: "127.0.0.1" });
  if (result.httpStatus !== 200) throw new Error(`M-Pesa confirmation for sale ${saleId} answered ${result.httpStatus.toString()}.`);
  bump(ctx, "M-Pesa confirmation");
}

/** Today's sales, through the online path; M-Pesa tenders confirmed through the STK flow. */
async function ringToday(ctx: Ctx, sales: readonly PlannedSale[]): Promise<void> {
  for (const planned of sales) {
    const reference = `${TAG}:sale:${planned.key}`;
    let sale = await ctx.db.sale.findFirst({ where: { reference } });
    if (sale === null) {
      const { lines, total } = linesOf(ctx, planned);
      const created = await recordSale(ctx.db, {
        shiftId: await shiftFor(ctx),
        createdBy: ctx.cashierId,
        lines,
        tenders: [{ tenderType: planned.tender, amount: decimal(total) }],
        ...(planned.tender === "CREDIT" ? { customerId: ctx.customerId } : {}),
        reference,
        sellingLocationId: ctx.tillId,
      });
      sale = await ctx.db.sale.findUniqueOrThrow({ where: { id: created.id } });
      bump(ctx, `online sale (${planned.tender})`);
    }
    if (planned.tender === "MPESA") await confirmMpesa(ctx, sale.id);
  }
}

async function seedSales(ctx: Ctx, deviceId: string): Promise<void> {
  const sales = plan();
  await syncHistory(ctx, deviceId, sales.filter((planned) => planned.online !== true));
  await seedBanking(ctx, sales);
  await ringToday(ctx, sales.filter((planned) => planned.online === true));
  for (const planned of sales.filter((p) => p.voidToday === true)) {
    const sale = await ctx.db.sale.findFirst({ where: { reference: `${TAG}:sale:${planned.key}` } });
    if (sale !== null && sale.status === "COMPLETED") {
      await voidSale(ctx.db, sale.id, "Customer returned the goods (dev seed: a last-month sale voided this month)", ctx.ownerId);
      bump(ctx, "void");
    }
  }
}

interface ExpenseSeed {
  key: string;
  back: number;
  day: number;
  category: string;
  payee: string;
  description: string;
  method: "CASH" | "MPESA" | "BANK";
  amount: number;
}

const EXPENSES: readonly ExpenseSeed[] = [
  ...[3, 2, 1, 0].flatMap((back): ExpenseSeed[] => [
    { key: `rent-m${back.toString()}`, back, day: 1, category: "6000", payee: "Westside Properties", description: "Shop rent", method: "BANK", amount: 35_000 },
    { key: `power-m${back.toString()}`, back, day: 8, category: "6010", payee: "Kenya Power", description: "Electricity (prepaid tokens)", method: "CASH", amount: 4_800 },
    { key: `fuel-m${back.toString()}`, back, day: 14, category: "6030", payee: "Rubis Nakuru", description: "Delivery pickup fuel", method: "CASH", amount: 6_500 + back * 700 },
    { key: `airtime-m${back.toString()}`, back, day: 16, category: "6050", payee: "Safaricom", description: "Airtime and data", method: "CASH", amount: 1_500 },
  ]),
  { key: "transport-m2", back: 2, day: 22, category: "6030", payee: "Mathenge Transporters", description: "Lorry hire for a site delivery", method: "CASH", amount: 9_000 },
  { key: "marketing-m1", back: 1, day: 6, category: "6040", payee: "Kass FM", description: "Radio advert", method: "BANK", amount: 12_000 },
  { key: "repairs-m1", back: 1, day: 27, category: "6060", payee: "Juma Welding", description: "Shop door repair", method: "CASH", amount: 3_500 },
  { key: "charges-m0", back: 0, day: 2, category: "6080", payee: "Equity Bank", description: "Bank and M-Pesa charges", method: "BANK", amount: 850 },
];

async function seedExpenses(ctx: Ctx): Promise<void> {
  for (const expense of EXPENSES) {
    const reference = `${TAG}:expense:${expense.key}`;
    if ((await ctx.db.expense.count({ where: { reference } })) > 0) continue;
    if (expense.back === 0 && expense.day > daysIn(0)) continue; // not yet happened this month
    await recordExpense(ctx.db, {
      expenseDate: dateOf(expense.back, expense.day),
      category: expense.category,
      payee: expense.payee,
      description: expense.description,
      paymentMethod: expense.method,
      amountCents: shillings(expense.amount),
      reference,
      createdBy: ctx.ownerId,
    });
    bump(ctx, "expense");
  }
}

/** Salaries: a real payroll run per completed month, posted and its net pay settled from the bank. */
async function seedPayroll(ctx: Ctx): Promise<void> {
  const staff = [
    { firstName: "Grace", lastName: "Wanjiru", basic: 28_000, allowance: 4_000, kraPin: "A012345678B", nationalId: "30111222" },
    { firstName: "Peter", lastName: "Otieno", basic: 32_000, allowance: 0, kraPin: "A087654321C", nationalId: "29333444" },
  ];
  for (const person of staff) {
    if ((await ctx.db.employee.count({ where: { firstName: person.firstName, lastName: person.lastName } })) > 0) continue;
    await createEmployee(ctx.db, {
      firstName: person.firstName,
      lastName: person.lastName,
      nationalId: person.nationalId,
      kraPin: person.kraPin,
      hireDate: dateOf(4, 1),
      basicSalary: shillings(person.basic),
      paymentMethod: "BANK",
      bankName: "Equity Bank",
      bankAccount: "0000000000",
      ...(person.allowance > 0 ? { allowances: [{ name: "House allowance", amount: shillings(person.allowance), taxable: true }] } : {}),
    });
    bump(ctx, "employee");
  }
  for (const back of [3, 2, 1]) {
    const [year, month] = monthOf(back);
    let run = await ctx.db.payrollRun.findFirst({ where: { periodYear: year, periodMonth: month, status: { not: "CANCELLED" } } });
    if (run === null) {
      const created = await createPayrollRun(ctx.db, { periodYear: year, periodMonth: month, payDate: dateOf(back, 31), notes: "Dev seed", createdById: ctx.ownerId });
      run = await ctx.db.payrollRun.findUniqueOrThrow({ where: { id: created.id } });
      bump(ctx, "payroll run");
    }
    if (run.status === "DRAFT") {
      await approvePayrollRun(ctx.db, run.id, ctx.ownerId);
      run = await ctx.db.payrollRun.findUniqueOrThrow({ where: { id: run.id } });
    }
    if (run.status === "APPROVED") {
      await postPayrollRun(ctx.db, run.id, ctx.ownerId);
      run = await ctx.db.payrollRun.findUniqueOrThrow({ where: { id: run.id } });
    }
    if (run.status === "POSTED") {
      await settleNetPay(ctx.db, run.id, {
        paymentDate: dateOf(back, 31),
        method: "BANK",
        reference: `${TAG}:netpay:${year.toString()}-${month.toString()}`,
        createdById: ctx.ownerId,
      });
      bump(ctx, "net-pay settlement");
    }
  }
}

async function main(): Promise<void> {
  const tenantRow = await platformDb.tenant.findUnique({ where: { subdomain: SUBDOMAIN } });
  if (tenantRow === null) throw new Error(`Tenant ${SUBDOMAIN} does not exist. Provision it first (npm run tenant:provision).`);
  const owner = await platformDb.user.findUnique({ where: { email: OWNER_EMAIL } });
  const cashier = await platformDb.user.findUnique({ where: { email: CASHIER_EMAIL } });
  if (owner === null || cashier === null) throw new Error("The Nakuru owner and cashier must exist first (npm run seed:users).");

  const ctx: Ctx = {
    db: getTenantDb(tenantRow.dbSchema),
    ownerId: owner.id,
    cashierId: cashier.id,
    products: new Map(),
    netSold: plannedNetSold(plan()),
    restocks: plannedRestocks(plan()),
    customerId: "",
    tillId: "",
    shiftId: null,
    counts: {},
  };

  await seedCapital(ctx);
  const deviceId = await seedTill(ctx);
  await seedProducts(ctx);
  const suppliers = await seedPartners(ctx);
  await seedPurchasing(ctx, suppliers);
  await seedSales(ctx, deviceId);
  await seedExpenses(ctx);
  await seedPayroll(ctx);

  const added = Object.entries(ctx.counts);
  console.log(
    added.length === 0
      ? `seed:transactions — ${SUBDOMAIN} already seeded; nothing added.`
      : `seed:transactions — ${SUBDOMAIN}: ${added.map(([what, n]) => `${n.toString()} ${what}`).join(", ")}.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? `seed:transactions failed: ${error.name}: ${error.message}` : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectAllTenantDbs();
    await platformDb.$disconnect();
    await closePool();
  });
