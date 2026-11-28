import { render } from "@testing-library/react";
import { vi } from "vitest";
import { Inventory } from "@/components/inventory/inventory";
import { Procurement } from "@/components/procurement/procurement";
import { DataProvider } from "@/components/providers/data-provider";
import { LocationProvider } from "@/components/shell/location";
import { ToastProvider } from "@/components/toast/toast";
import type { Role } from "@/lib/auth/landing";
import type { Location, Supplier } from "@/lib/inventory/inventory";
import { parseCents } from "@/lib/money";
import { fromMilli, toMilli } from "@/lib/pos/quantity";
import { product } from "./catalog";

// A fake inventory server for the stock and procurement tests: products, what each location owns,
// suppliers, locations and an append-only movement log, answering the BFF routes the screens call
// with the API's shapes. Writes change the state, so a later read shows the new stock — which is
// what "posts and reflects the new stock" means. Requests are recorded for the shilling checks.

export interface Call {
  method: string;
  url: URL;
  body: unknown;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (status: number, message: string) => json(status, { statusCode: status, error: "Error", message });
const shillingsToCents = (amount: string) => {
  if (!/^\d+\.\d{2}$/.test(amount)) throw new Error(`not a shilling string: ${amount}`);
  return parseCents(amount.replace(".", ""));
};

function location(id: string, name: string, code: string, type: Location["type"], over: Partial<Location> = {}): Location {
  return {
    id,
    name,
    code,
    type,
    isDefault: type === "MAIN",
    isActive: true,
    isOfflineCapable: false,
    leaseWindowMinutes: null,
    sessionStart: null,
    sessionEnd: null,
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z",
    ...over,
  };
}

export const MAIN = location("loc-main", "Main store", "MAIN", "MAIN");
export const TILL = location("loc-till", "Till 1", "TILL-1", "POS", { isOfflineCapable: true, leaseWindowMinutes: 480 });
export const CEMENT = product({ id: "p-cem", sku: "NKH-CEM-50", name: "Bamburi Cement 50kg", unitOfMeasure: "bag", costPrice: "69000", minStockThreshold: "20.000" });
export const NAILS = product({ id: "p-nai", sku: "NKH-NAI-4", name: "Wire Nails 4in", unitOfMeasure: "kg", costPrice: "15000", minStockThreshold: "50.000" });
export const PAINT = product({ id: "p-pnt", sku: "NKH-PNT-4", name: "Crown Paint 4L", unitOfMeasure: "tin", costPrice: "120000", minStockThreshold: "0.000" });

export function supplier(over: Partial<Supplier> = {}): Supplier {
  return {
    id: "sup-1",
    name: "Bamburi Distributors",
    contactName: "Achieng",
    phone: "0711000111",
    email: null,
    kraPin: null,
    paymentTerms: "Net 30",
    leadTimeDays: 3,
    isActive: true,
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z",
    ...over,
  };
}

export interface StockServer {
  calls: Call[];
  routes: Array<(call: Call) => Response | null>;
  qty: (productId: string, locationId?: string) => string;
  locations: Location[];
  suppliers: Supplier[];
  /** Move stock as the server would (a receipt, a sale…), writing the movement row. */
  move: (productId: string, locationId: string, delta: bigint, type: string, extra?: Record<string, unknown>) => Record<string, unknown>;
}

/** Installs the fake server: MAIN holds 140 cement and 30 nails (nails below their reorder level), Till 1 holds 10 cement. */
export function installStockServer(): StockServer {
  const products = [CEMENT, NAILS, PAINT];
  const owned = new Map<string, Map<string, bigint>>([
    [CEMENT.id, new Map([[MAIN.id, toMilli("140")], [TILL.id, toMilli("10")]])],
    [NAILS.id, new Map([[MAIN.id, toMilli("30")]])],
    [PAINT.id, new Map()],
  ]);
  const movements: Array<Record<string, unknown>> = [];
  const state: StockServer = {
    calls: [],
    routes: [],
    locations: [MAIN, TILL],
    suppliers: [supplier(), supplier({ id: "sup-2", name: "Old Supplier", isActive: false })],
    move: (productId, locationId, delta, type, extra) => move(productId, locationId, delta, type, extra),
    qty: (productId, locationId) => {
      const slices = owned.get(productId) ?? new Map<string, bigint>();
      const milli = locationId ? (slices.get(locationId) ?? 0n) : [...slices.values()].reduce((a, b) => a + b, 0n);
      return fromMilli(milli);
    },
  };
  const total = (productId: string) => toMilli(state.qty(productId));
  const unitCost = (productId: string) => parseCents(products.find((p) => p.id === productId)?.costPrice ?? "0");
  const value = (productId: string, milli: bigint) => (unitCost(productId) * milli) / 1000n;
  const nameOf = (id: string) => state.locations.find((l) => l.id === id);

  function move(productId: string, locationId: string, delta: bigint, type: string, extra: Record<string, unknown> = {}) {
    const slices = owned.get(productId) ?? new Map<string, bigint>();
    owned.set(productId, slices);
    slices.set(locationId, (slices.get(locationId) ?? 0n) + delta);
    const after = total(productId);
    const row = {
      id: `mv-${(movements.length + 1).toString()}`,
      productId,
      movementType: type,
      quantity: fromMilli(delta < 0n ? -delta : delta),
      unitCost: unitCost(productId).toString(),
      totalCost: value(productId, delta < 0n ? -delta : delta).toString(),
      balanceQty: fromMilli(after),
      balanceValue: value(productId, after).toString(),
      avgCostAfter: unitCost(productId).toString(),
      avgCostAfterPrecise: unitCost(productId).toString(),
      supplierId: null,
      reference: null,
      notes: null,
      journalEntryId: type.startsWith("TRANSFER") ? null : `je-${(movements.length + 1).toString()}`,
      locationId: locationId === MAIN.id ? null : locationId,
      goodsReceiptId: null,
      purchaseOrderLineId: null,
      createdBy: "user-1",
      createdAt: new Date(Date.UTC(2026, 10, 5, 8, movements.length)).toISOString(),
      ...extra,
    };
    movements.unshift(row);
    return row;
  }

  const stockRow = (p: (typeof products)[number]) => {
    const count = total(p.id);
    return {
      productId: p.id,
      sku: p.sku,
      name: p.name,
      category: p.category,
      unitOfMeasure: p.unitOfMeasure,
      stockCount: fromMilli(count),
      minStockThreshold: p.minStockThreshold,
      reorderQuantity: null,
      avgCost: p.costPrice,
      avgCostPrecise: p.costPrice,
      stockValue: value(p.id, count).toString(),
      belowReorder: toMilli(p.minStockThreshold) > 0n && count <= toMilli(p.minStockThreshold),
    };
  };

  const answer = (call: Call): Response | null => {
    const path = call.url.pathname;
    const body = call.body as Record<string, string | boolean | number | null | undefined>;
    if (path === "/api/v1/locations" && call.method === "GET") {
      const active = call.url.searchParams.get("activeOnly") === "true";
      return json(200, { data: state.locations.filter((l) => !active || l.isActive) });
    }
    if (path === "/api/v1/locations" && call.method === "POST") {
      if (state.locations.some((l) => l.code === body.code)) return refusal(409, `A location with code "${String(body.code)}" already exists.`);
      const created = location(`loc-${String(body.code).toLowerCase()}`, String(body.name), String(body.code), body.type as Location["type"], {
        isOfflineCapable: Boolean(body.isOfflineCapable),
        leaseWindowMinutes: body.isOfflineCapable ? (body.leaseWindowMinutes === undefined ? 480 : (body.leaseWindowMinutes as number | null)) : null,
        sessionStart: (body.sessionStart as string | undefined) ?? null,
        sessionEnd: (body.sessionEnd as string | undefined) ?? null,
      });
      state.locations.push(created);
      return json(201, created);
    }
    const loc = /^\/api\/v1\/locations\/([^/]+)(?:\/(activate|deactivate))?$/.exec(path);
    if (loc && call.method === "PATCH") {
      const found = state.locations.find((l) => l.id === loc[1]);
      if (!found) return refusal(404, "No location.");
      if (loc[2] === "deactivate") {
        const holds = [...owned.values()].some((slices) => (slices.get(found.id) ?? 0n) > 0n);
        if (holds) return refusal(409, `${found.name} still owns stock; transfer it out before deactivating.`);
        found.isActive = false;
      } else if (loc[2] === "activate") {
        found.isActive = true;
      } else {
        Object.assign(found, Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)));
        if (body.isOfflineCapable === false) found.leaseWindowMinutes = null;
      }
      return json(200, found);
    }
    if (path === "/api/v1/inventory/stock") {
      const below = call.url.searchParams.get("belowReorder") === "true";
      const data = products.map(stockRow).filter((r) => !below || r.belowReorder);
      return json(200, { data, count: data.length });
    }
    if (path === "/api/v1/inventory/stock/by-location") {
      const id = call.url.searchParams.get("locationId") ?? "";
      const place = nameOf(id);
      const data = products
        .filter((p) => (owned.get(p.id)?.get(id) ?? 0n) > 0n)
        .map((p) => {
          const q = owned.get(p.id)?.get(id) ?? 0n;
          return { productId: p.id, sku: p.sku, name: p.name, locationId: id, locationCode: place?.code ?? "", locationName: place?.name ?? "", quantity: fromMilli(q), frozenQuantity: "0", sellableQuantity: fromMilli(q), avgCost: p.costPrice, avgCostPrecise: p.costPrice, value: value(p.id, q).toString() };
        });
      return json(200, { data, count: data.length });
    }
    const split = /^\/api\/v1\/inventory\/stock\/([^/]+)\/by-location$/.exec(path);
    if (split) {
      const p = products.find((x) => x.id === split[1]);
      if (!p) return refusal(404, "No product.");
      const slices = [...(owned.get(p.id) ?? new Map<string, bigint>()).entries()].filter(([, q]) => q > 0n);
      const count = total(p.id);
      return json(200, {
        productId: p.id,
        sku: p.sku,
        name: p.name,
        aggregateStockCount: fromMilli(count),
        locationTotal: fromMilli(count),
        matches: true,
        stockValue: value(p.id, count).toString(),
        locationValueTotal: value(p.id, count).toString(),
        valueMatches: true,
        avgCost: p.costPrice,
        avgCostPrecise: p.costPrice,
        locations: slices.map(([id, q]) => ({ locationId: id, locationCode: nameOf(id)?.code ?? "", locationName: nameOf(id)?.name ?? "", quantity: fromMilli(q), value: value(p.id, q).toString() })),
      });
    }
    const history = /^\/api\/v1\/inventory\/stock\/([^/]+)\/movements$/.exec(path);
    if (history) {
      const rows = movements.filter((m) => m.productId === history[1]);
      const take = Number(call.url.searchParams.get("take") ?? "25");
      const skip = Number(call.url.searchParams.get("skip") ?? "0");
      return json(200, { productId: history[1], rows: rows.slice(skip, skip + take), pagination: { take, skip, total: rows.length } });
    }
    if (call.method === "POST" && path === "/api/v1/inventory/receipts") {
      shillingsToCents(String(body.unitCost));
      return json(201, move(String(body.productId), MAIN.id, toMilli(String(body.quantity)), "PURCHASE_RECEIPT", { supplierId: body.supplierId ?? null }));
    }
    if (call.method === "POST" && (path === "/api/v1/inventory/adjustments" || path === "/api/v1/inventory/write-offs")) {
      const qty = toMilli(String(body.quantity));
      const down = path.endsWith("write-offs") || body.movementType === "ADJUSTMENT_DECREASE";
      if (body.unitCost !== undefined) shillingsToCents(String(body.unitCost));
      const at = owned.get(String(body.productId))?.get(MAIN.id) ?? 0n;
      const p = products.find((x) => x.id === body.productId);
      if (down && qty > at) return refusal(400, `Insufficient stock for ${p?.sku ?? ""} (${p?.name ?? ""}) at MAIN: requested ${fromMilli(qty)}, available ${fromMilli(at)}.`);
      return json(201, move(String(body.productId), MAIN.id, down ? -qty : qty, path.endsWith("write-offs") ? "WRITE_OFF" : String(body.movementType), { notes: body.notes ?? null }));
    }
    if (call.method === "POST" && path === "/api/v1/inventory/transfers") {
      const qty = toMilli(String(body.quantity));
      const from = String(body.fromLocationId);
      const to = String(body.toLocationId);
      const at = owned.get(String(body.productId))?.get(from) ?? 0n;
      if (qty > at) return refusal(400, `Insufficient stock at ${nameOf(from)?.code ?? ""}: requested ${fromMilli(qty)}, available ${fromMilli(at)}.`);
      move(String(body.productId), from, -qty, "TRANSFER_OUT");
      move(String(body.productId), to, qty, "TRANSFER_IN");
      return json(201, {
        productId: body.productId,
        sku: "",
        quantity: fromMilli(qty),
        fromLocationId: from,
        fromLocationCode: nameOf(from)?.code ?? "",
        fromQuantityAfter: state.qty(String(body.productId), from),
        toLocationId: to,
        toLocationCode: nameOf(to)?.code ?? "",
        toQuantityAfter: state.qty(String(body.productId), to),
        productStockCount: state.qty(String(body.productId)),
        avgCost: "0",
        avgCostPrecise: "0",
        valueMoved: "0",
        outMovementId: "mv-o",
        inMovementId: "mv-i",
        createdAt: "2026-11-05T08:00:00.000Z",
      });
    }
    if (path === "/api/v1/inventory/valuation") {
      const rows = products.map(stockRow);
      const totalValue = rows.reduce((sum, r) => sum + parseCents(r.stockValue), 0n).toString();
      return json(200, {
        asOf: call.url.searchParams.get("asOf") ?? "2026-11-05",
        totalStockValue: totalValue,
        products: rows.map((r) => ({ productId: r.productId, sku: r.sku, name: r.name, stockCount: r.stockCount, avgCost: r.avgCost, avgCostPrecise: r.avgCost, stockValue: r.stockValue })),
        byLocation: state.locations.map((l) => {
          const q = products.reduce((sum, p) => sum + (owned.get(p.id)?.get(l.id) ?? 0n), 0n);
          const v = products.reduce((sum, p) => sum + value(p.id, owned.get(p.id)?.get(l.id) ?? 0n), 0n);
          return { locationId: l.id, locationCode: l.code, locationName: l.name, quantity: fromMilli(q), value: v.toString() };
        }),
        reconciliation: { inventoryValue: totalValue, glAccount1200Balance: totalValue, difference: "0", reconciled: true, byLocationTotal: totalValue, locationSplitMatches: true, zeroInvariantHolds: true },
      });
    }
    if (path === "/api/v1/inventory/suppliers" && call.method === "GET") return json(200, { data: state.suppliers });
    if (path === "/api/v1/inventory/suppliers" && call.method === "POST") {
      const created = supplier({ id: `sup-${(state.suppliers.length + 1).toString()}`, name: String(body.name), contactName: (body.contactName as string) ?? null, phone: (body.phone as string) ?? null, paymentTerms: (body.paymentTerms as string) ?? null, leadTimeDays: (body.leadTimeDays as number) ?? null });
      state.suppliers.push(created);
      return json(201, created);
    }
    const sup = /^\/api\/v1\/inventory\/suppliers\/([^/]+)$/.exec(path);
    if (sup && call.method === "PATCH") {
      const found = state.suppliers.find((s) => s.id === sup[1]);
      if (!found) return refusal(404, "No supplier.");
      Object.assign(found, body);
      return json(200, found);
    }
    if (path === "/api/v1/products") {
      const q = (call.url.searchParams.get("q") ?? "").toLowerCase();
      const data = products.filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q));
      return json(200, { data, pagination: { take: 20, skip: 0, total: data.length } });
    }
    return null;
  };

  document.cookie = "ag_csrf=csrf-token; path=/";
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const call: Call = { method: init.method ?? "GET", url: new URL(input, "http://app.test"), body: typeof init.body === "string" ? JSON.parse(init.body) : undefined };
    state.calls.push(call);
    for (const route of state.routes) {
      const routed = route(call);
      if (routed) return routed;
    }
    return answer(call) ?? json(404, { statusCode: 404, error: "Not Found", message: "unrouted" });
  });
  return state;
}

export const posts = (server: StockServer, path: string) => server.calls.filter((c) => c.method === "POST" && c.url.pathname === `/api/v1${path}`).map((c) => c.body);

export function showInventory(role: Role = "MSME_OWNER") {
  return render(
    <ToastProvider>
      <DataProvider>
        <LocationProvider enabled>
          <main>
            <Inventory role={role} />
          </main>
        </LocationProvider>
      </DataProvider>
    </ToastProvider>,
  );
}

/**
 * Purchase orders on the fake server: the lifecycle the API enforces (draft → approved → partly /
 * fully received → closed; cancel only before anything arrives), receiving that moves stock in and
 * records GRN-tagged movements, the GRN read, and the ledger entry each receipt posts.
 */
export function installProcurement(server: StockServer) {
  type Line = { id: string; productId: string; sku: string; productName: string; orderedQty: string; unitCost: string; lineNet: string; receivedQty: string };
  type Order = Record<string, unknown> & { id: string; poNumber: number; status: string; lines: Line[]; subtotal: string; notes: unknown };
  const orders: Order[] = [];
  const grns = new Map<string, Record<string, unknown> & { totalAccrued: string }>();
  const products = [CEMENT, NAILS, PAINT];
  const cents = (amount: string) => {
    if (!/^\d+\.\d{2}$/.test(amount)) throw new Error(`not a shilling string: ${amount}`);
    return BigInt(amount.replace(".", ""));
  };
  const linesOf = (raw: Array<{ productId: string; quantity: string; unitCost: string }>, prefix: string): Line[] =>
    raw.map((l, i) => {
      const p = products.find((x) => x.id === l.productId);
      return {
        id: `${prefix}-l${(i + 1).toString()}`,
        productId: l.productId,
        sku: p?.sku ?? "",
        productName: p?.name ?? "",
        orderedQty: fromMilli(toMilli(l.quantity)),
        unitCost: cents(l.unitCost).toString(),
        lineNet: ((cents(l.unitCost) * toMilli(l.quantity)) / 1000n).toString(),
        receivedQty: "0",
      };
    });
  const subtotal = (lines: Line[]) => lines.reduce((sum, l) => sum + BigInt(l.lineNet), 0n).toString();
  const supplierName = (id: string) => server.suppliers.find((s) => s.id === id)?.name ?? "";
  const conflict = (message: string) => json(409, { statusCode: 409, error: "Conflict", message });

  server.routes.push((call) => {
    const path = call.url.pathname;
    const body = (call.body ?? {}) as Record<string, unknown>;
    if (path === "/api/v1/procurement/purchase-orders" && call.method === "GET") {
      const status = call.url.searchParams.get("status");
      const data = orders.filter((o) => !status || o.status === status);
      return json(200, { data, count: data.length });
    }
    if (path === "/api/v1/procurement/purchase-orders" && call.method === "POST") {
      const id = `po-${(orders.length + 1).toString()}`;
      const lines = linesOf(body.lines as Array<{ productId: string; quantity: string; unitCost: string }>, id);
      const order: Order = {
        id,
        poNumber: orders.length + 1,
        supplierId: body.supplierId,
        supplierName: supplierName(String(body.supplierId)),
        status: "DRAFT",
        orderDate: `${String(body.orderDate)}T00:00:00.000Z`,
        expectedDate: body.expectedDate ? `${String(body.expectedDate)}T00:00:00.000Z` : null,
        currency: "KES",
        subtotal: subtotal(lines),
        notes: body.notes ?? null,
        createdById: "user-1",
        approvedById: null,
        approvedAt: null,
        createdAt: "2026-11-05T08:00:00.000Z",
        updatedAt: "2026-11-05T08:00:00.000Z",
        lines,
      };
      orders.unshift(order);
      return json(201, order);
    }
    const one = /^\/api\/v1\/procurement\/purchase-orders\/([^/]+)(?:\/(approve|cancel|close|receive))?$/.exec(path);
    if (one) {
      const order = orders.find((o) => o.id === one[1]);
      if (!order) return json(404, { statusCode: 404, error: "Not Found", message: "No purchase order." });
      const step = one[2];
      if (!step && call.method === "GET") return json(200, order);
      if (!step && call.method === "PATCH") {
        if (order.status !== "DRAFT") return conflict("Only a DRAFT purchase order can be edited.");
        if (body.lines) {
          order.lines = linesOf(body.lines as Array<{ productId: string; quantity: string; unitCost: string }>, `${order.id}-e`);
          order.subtotal = subtotal(order.lines);
        }
        if (body.supplierId) Object.assign(order, { supplierId: body.supplierId, supplierName: supplierName(String(body.supplierId)) });
        if (body.notes !== undefined) order.notes = body.notes;
        return json(200, order);
      }
      const allowed: Record<string, string[]> = { approve: ["DRAFT"], cancel: ["DRAFT", "APPROVED"], close: ["PARTIALLY_RECEIVED", "RECEIVED"], receive: ["APPROVED", "PARTIALLY_RECEIVED"] };
      if (step && !(allowed[step] ?? []).includes(order.status)) return conflict(`A ${order.status} purchase order cannot be ${step === "receive" ? "received against" : `${step}d`}.`);
      if (step === "approve") Object.assign(order, { status: "APPROVED", approvedById: "user-1", approvedAt: "2026-11-05T09:00:00.000Z" });
      if (step === "cancel") order.status = "CANCELLED";
      if (step === "close") order.status = "CLOSED";
      if (step === "receive") {
        const asked = body.lines as Array<{ purchaseOrderLineId: string; quantity: string }>;
        for (const r of asked) {
          const line = order.lines.find((l) => l.id === r.purchaseOrderLineId);
          if (!line) return json(400, { statusCode: 400, error: "Bad Request", message: "Unknown line." });
          const left = toMilli(line.orderedQty) - toMilli(line.receivedQty);
          if (toMilli(r.quantity) > left) return json(400, { statusCode: 400, error: "Bad Request", message: `Line ${line.sku} would be over-received: it still expects ${fromMilli(left)}.` });
        }
        const grnId = `grn-${(grns.size + 1).toString()}`;
        const location = String(body.receivingLocationId ?? MAIN.id);
        const lines = asked.map((r) => {
          const line = order.lines.find((l) => l.id === r.purchaseOrderLineId) as Line;
          const qty = toMilli(r.quantity);
          line.receivedQty = fromMilli(toMilli(line.receivedQty) + qty);
          const totalCost = ((BigInt(line.unitCost) * qty) / 1000n).toString();
          const mv = server.move(line.productId, location, qty, "PURCHASE_RECEIPT", { goodsReceiptId: grnId, purchaseOrderLineId: line.id, totalCost, journalEntryId: `je-${grnId}` });
          return { purchaseOrderLineId: line.id, productId: line.productId, sku: line.sku, quantity: fromMilli(qty), totalCost, stockMovementId: String(mv.id), journalEntryId: `je-${grnId}` };
        });
        order.status = order.lines.every((l) => toMilli(l.receivedQty) === toMilli(l.orderedQty)) ? "RECEIVED" : "PARTIALLY_RECEIVED";
        const grn = {
          id: grnId,
          grnNumber: grns.size + 1,
          poId: order.id,
          poNumber: order.poNumber,
          receivingLocationId: location,
          receivingLocationCode: server.locations.find((l) => l.id === location)?.code ?? "",
          receivedById: "user-1",
          receivedAt: `${String(body.receivedAt ?? "2026-11-05")}T00:00:00.000Z`,
          notes: body.notes ?? null,
          createdAt: "2026-11-05T10:00:00.000Z",
          lines,
          purchaseOrderStatus: order.status,
          totalAccrued: lines.reduce((sum, l) => sum + BigInt(l.totalCost), 0n).toString(),
        };
        grns.set(grnId, grn);
        return json(201, grn);
      }
      return json(200, order);
    }
    const orderGrns = /^\/api\/v1\/procurement\/purchase-orders\/([^/]+)\/goods-receipts$/.exec(path);
    if (orderGrns) {
      // The receipts of one order, oldest first (T-B-PO-GRN-LIST).
      const data = [...grns.values()].filter((g) => g.poId === orderGrns[1]);
      return json(200, { data });
    }
    const grn = /^\/api\/v1\/procurement\/goods-receipts\/([^/]+)$/.exec(path);
    if (grn) {
      const found = grns.get(grn[1] ?? "");
      return found ? json(200, found) : json(404, { statusCode: 404, error: "Not Found", message: "No goods receipt." });
    }
    const entry = /^\/api\/v1\/ledger\/entries\/je-(grn-\d+)$/.exec(path);
    if (entry) {
      const g = grns.get(entry[1] ?? "");
      if (!g) return null;
      return json(200, {
        id: `je-${entry[1] ?? ""}`,
        entryNumber: "JE-000123",
        entryDate: "2026-11-05T00:00:00.000Z",
        periodYear: 2026,
        periodMonth: 11,
        description: "Goods receipt",
        reference: null,
        source: "PROCUREMENT",
        sourceId: entry[1],
        status: "POSTED",
        reversesEntryId: null,
        reversedByEntryId: null,
        createdBy: "user-1",
        postedAt: "2026-11-05T10:00:00.000Z",
        lines: [
          { id: "jl-1", entryId: "je", lineNumber: 1, accountId: "a-1200", debit: g.totalAccrued, credit: "0", memo: null, account: { code: "1200", name: "Inventory", accountClass: "ASSET" } },
          { id: "jl-2", entryId: "je", lineNumber: 2, accountId: "a-2050", debit: "0", credit: g.totalAccrued, memo: null, account: { code: "2050", name: "Goods Received Not Invoiced", accountClass: "LIABILITY" } },
        ],
      });
    }
    return null;
  });
  return { orders };
}

export function showProcurement(role: Role = "MSME_OWNER") {
  return render(
    <ToastProvider>
      <DataProvider>
        <LocationProvider enabled>
          <main>
            <Procurement role={role} />
          </main>
        </LocationProvider>
      </DataProvider>
    </ToastProvider>,
  );
}
