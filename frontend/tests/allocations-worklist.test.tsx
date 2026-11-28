// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestsView } from "@/components/inventory/requests";
import { TillsView } from "@/components/inventory/tills";
import { allocationPermissions } from "@/lib/allocations/allocations";
import { axeViolations } from "./support/catalog";
import { show } from "./support/mentorship";

// M4.5 W3, the owner / manager side: the stock-request worklist (approve as asked, approve a
// different quantity, decline; MAIN short → nothing moves and it stays pending; already decided →
// said so; plus sending other stock directly) and the cashier-tills screen (assign, move, remove).
// A stateful fake API holds the requests and assignments.

vi.mock("next/navigation", () => ({ usePathname: () => "/inventory", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

interface Call {
  method: string;
  url: URL;
  body: unknown;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (status: number, message: string) => json(status, { statusCode: status, error: "Error", message });

const LOCATIONS = [
  { id: "loc-main", name: "Main store", code: "MAIN", type: "MAIN", isDefault: true, isActive: true },
  { id: "loc-a", name: "Till A", code: "TA", type: "POS", isDefault: false, isActive: true },
  { id: "loc-b", name: "Till B", code: "TB", type: "POS", isDefault: false, isActive: true },
  { id: "loc-web", name: "Web shop", code: "WEB", type: "ECOMMERCE", isDefault: false, isActive: true },
];

const request = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  productId: "p-nai",
  sku: "NKH-NAI-4",
  productName: "Wire Nails 4in",
  locationId: "loc-a",
  locationCode: "TA",
  locationName: "Till A",
  requestedQty: "10.000",
  approvedQty: null,
  status: "PENDING",
  requestedBy: "u-cash",
  decidedBy: null,
  decidedAt: null,
  transferId: null,
  note: "Running out before the weekend",
  createdAt: "2026-11-16T08:00:00.000Z",
  updatedAt: "2026-11-16T08:00:00.000Z",
  ...over,
});

let calls: Call[];
let requests: Array<Record<string, unknown>>;
let mainHolds: number;
let cashiers: Array<Record<string, unknown>>;

beforeEach(() => {
  calls = [];
  requests = [request("r-1"), request("r-2", { productName: "Bamburi Cement 50kg", productId: "p-cem", sku: "NKH-CEM-50", locationId: "loc-b", locationName: "Till B", requestedQty: "3.000" })];
  mainHolds = 6;
  cashiers = [
    { userId: "u-cash", fullName: "Akinyi Otieno", email: "akinyi@shop.test", location: { id: "loc-a", code: "TA", name: "Till A", type: "POS" }, assignedBy: "u-mgr", assignedAt: "2026-11-15T08:00:00.000Z" },
    { userId: "u-new", fullName: "Brian Kip", email: "brian@shop.test", location: null, assignedBy: null, assignedAt: null },
  ];
  document.cookie = "ag_csrf=csrf-token; path=/";
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const call: Call = { method: init.method ?? "GET", url: new URL(input, "http://app.test"), body: typeof init.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const path = call.url.pathname.replace(/^\/api\/v1/, "");
    const body = (call.body ?? {}) as Record<string, string>;
    if (path === "/locations") return json(200, { data: LOCATIONS });
    if (path === "/products") return json(200, { data: [{ id: "p-tape", sku: "NKH-TAPE", name: "Duct tape", unitOfMeasure: "roll", costPrice: "10000", kind: "GOOD" }], pagination: { take: 20, skip: 0, total: 1 } });
    if (path === "/allocations/requests" && call.method === "GET") {
      const status = call.url.searchParams.get("status");
      const data = requests.filter((r) => !status || r.status === status);
      return json(200, { data, count: data.length });
    }
    let m: RegExpExecArray | null;
    if ((m = /^\/allocations\/requests\/([^/]+)\/decide$/.exec(path))) {
      const found = requests.find((r) => r.id === m?.[1]);
      if (!found) return refusal(404, "Unknown allocation request.");
      if (found.status !== "PENDING") return refusal(409, `Allocation request ${String(found.id)} is ${String(found.status)}, not PENDING.`);
      if (body.decision === "DECLINED") {
        found.status = "DECLINED";
        return json(200, found);
      }
      const qty = Number(body.approvedQty ?? String(found.requestedQty));
      if (qty > mainHolds) return refusal(400, `Insufficient stock for NKH-NAI-4 (Wire Nails 4in): requested ${String(qty)}.000, available ${String(mainHolds)}.000.`);
      Object.assign(found, { status: "APPROVED", approvedQty: `${String(qty)}.000` });
      return json(200, found);
    }
    if (path === "/allocations" && call.method === "POST") {
      return json(201, { productId: body.productId, sku: "NKH-TAPE", quantity: `${body.quantity}.000`, fromLocationId: "loc-main", fromLocationCode: "MAIN", fromQuantityAfter: "38.000", toLocationId: body.toLocationId, toLocationCode: "TB", toQuantityAfter: "2.000", sourceDefaulted: true, productStockCount: "40.000", outMovementId: "m1", inMovementId: "m2", createdAt: "2026-11-16T09:00:00.000Z" });
    }
    if (path === "/pos/cashier-assignments") return json(200, { data: cashiers });
    if ((m = /^\/pos\/cashier-assignments\/([^/]+)$/.exec(path))) {
      const cashier = cashiers.find((c) => c.userId === m?.[1]);
      if (!cashier) return refusal(404, "No active cashier with that id in this business.");
      if (call.method === "DELETE") {
        cashier.location = null;
        return new Response(null, { status: 204 });
      }
      const place = LOCATIONS.find((l) => l.id === body.locationId);
      cashier.location = place ? { id: place.id, code: place.code, name: place.name, type: place.type } : null;
      return json(200, cashier);
    }
    return json(404, { statusCode: 404, error: "Not Found", message: "unrouted" });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const decided = () => calls.filter((c) => c.method === "POST" && /\/decide$/.test(c.url.pathname)).map((c) => [c.url.pathname.split("/")[5], c.body]);

describe("the stock-request worklist", () => {
  it("approves a request as asked: the stock is sent and the notice says nothing was posted", async () => {
    const user = userEvent.setup();
    show(<RequestsView permissions={allocationPermissions("MSME_MANAGER")} />);
    const list = await screen.findByRole("list", { name: "Stock requests" });
    expect(await axeViolations()).toEqual([]);
    const row = within(list).getByText(/Cement/).closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Decide" }));
    await user.click(within(row).getByRole("button", { name: "Approve and send" }));
    expect(await screen.findByText(/Sent 3 × Bamburi Cement 50kg from MAIN to Till B\. The stock moved; nothing was posted to the books\./)).toBeInTheDocument();
    expect(decided()).toEqual([["r-2", { decision: "APPROVED" }]]);
    // Decided, it leaves the "waiting" list.
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Stock requests" })).queryByText(/Cement/)).not.toBeInTheDocument());
  });

  it("approves a different quantity; when MAIN is short nothing moves and the request stays waiting", async () => {
    const user = userEvent.setup();
    show(<RequestsView permissions={allocationPermissions("MSME_OWNER")} />);
    const list = await screen.findByRole("list", { name: "Stock requests" });
    const row = within(list).getByText(/Wire Nails/).closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Decide" }));
    const qty = within(row).getByLabelText("Quantity to send");
    expect(qty).toHaveValue("10");
    await user.click(within(row).getByRole("button", { name: "Approve and send" }));
    expect(await within(row).findByRole("alert")).toHaveTextContent(/Insufficient stock.*Nothing moved and the request is still waiting/);
    expect(requests[0]?.status).toBe("PENDING");
    await user.clear(qty);
    await user.type(qty, "4");
    await user.click(within(row).getByRole("button", { name: "Approve and send" }));
    expect(await screen.findByText(/Sent 4 × Wire Nails 4in from MAIN to Till A/)).toBeInTheDocument();
    expect(decided()).toEqual([
      ["r-1", { decision: "APPROVED" }],
      ["r-1", { decision: "APPROVED", approvedQty: "4" }],
    ]);
  });

  it("declines, and says so clearly when someone already decided", async () => {
    const user = userEvent.setup();
    show(<RequestsView permissions={allocationPermissions("MSME_MANAGER")} />);
    const list = await screen.findByRole("list", { name: "Stock requests" });
    let row = within(list).getByText(/Wire Nails/).closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Decide" }));
    // Someone else decides it first.
    (requests[0] as Record<string, unknown>).status = "APPROVED";
    await user.click(within(row).getByRole("button", { name: "Decline" }));
    expect(await within(row).findByRole("alert")).toHaveTextContent(/not PENDING\. Someone may already have decided it/);
    row = within(await screen.findByRole("list", { name: "Stock requests" })).getByText(/Cement/).closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Decide" }));
    await user.click(within(row).getByRole("button", { name: "Decline" }));
    expect(await screen.findByText(/Declined\. Nothing moved/)).toBeInTheDocument();
    expect(decided().at(-1)).toEqual(["r-2", { decision: "DECLINED" }]);
  });

  it("sends other stock straight to a request's till", async () => {
    const user = userEvent.setup();
    show(<RequestsView permissions={allocationPermissions("MSME_MANAGER")} />);
    const list = await screen.findByRole("list", { name: "Stock requests" });
    const row = within(list).getByText(/Cement/).closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Send other stock to Till B" }));
    const form = screen.getByRole("form", { name: "Send stock to a location" });
    expect(within(form).getByLabelText("Send to")).toHaveValue("loc-b");
    expect(within(form).queryByRole("option", { name: "Main store" })).toBeNull();
    await user.type(within(form).getByLabelText("Product"), "tape");
    await user.click(await within(form).findByRole("button", { name: /Duct tape/ }));
    await user.type(within(form).getByLabelText("Quantity"), "2");
    await user.click(within(form).getByRole("button", { name: "Send stock" }));
    expect(await screen.findByText(/Sent 2 × Duct tape from MAIN to TB\. MAIN now holds 38, TB holds 2\./)).toBeInTheDocument();
    expect(calls.find((c) => c.url.pathname === "/api/v1/allocations")?.body).toEqual({ productId: "p-tape", toLocationId: "loc-b", quantity: "2" });
  });

  it("offers each role only what the API allows", async () => {
    show(<RequestsView permissions={allocationPermissions("WAREHOUSE_STAFF")} />);
    await screen.findByRole("list", { name: "Stock requests" });
    expect(screen.queryByRole("button", { name: "Decide" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send stock to a location" })).toBeInTheDocument();
    cleanup();
    show(<RequestsView permissions={allocationPermissions("VIEWER_AUDITOR")} />);
    await screen.findByRole("list", { name: "Stock requests" });
    expect(screen.queryByRole("button", { name: "Decide" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send stock to a location" })).toBeNull();
  });
});

describe("cashier tills", () => {
  it("assigns a cashier, moves one with a note about their open shift, and removes an assignment", async () => {
    const user = userEvent.setup();
    show(<TillsView />);
    const list = await screen.findByRole("list", { name: "Cashiers" });
    expect(await axeViolations()).toEqual([]);
    // A storefront is never offered as a till.
    expect(within(list).getByLabelText("Till for Brian Kip").querySelectorAll("option")).toHaveLength(4);

    await user.selectOptions(within(list).getByLabelText("Till for Brian Kip"), "loc-b");
    await user.click(within(within(list).getByText("Brian Kip").closest("li") as HTMLElement).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Brian Kip now sells from Till B.")).toBeInTheDocument();

    await user.selectOptions(within(list).getByLabelText("Till for Akinyi Otieno"), "loc-b");
    await user.click(within(within(list).getByText("Akinyi Otieno").closest("li") as HTMLElement).getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Akinyi Otieno moved to Till B\. If they have a shift open at Till A, they close it/)).toBeInTheDocument();

    await user.selectOptions(within(await screen.findByRole("list", { name: "Cashiers" })).getByLabelText("Till for Akinyi Otieno"), "");
    await user.click(within(within(screen.getByRole("list", { name: "Cashiers" })).getByText("Akinyi Otieno").closest("li") as HTMLElement).getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/no longer assigned to a till/)).toBeInTheDocument();
    const writes = calls.filter((c) => c.url.pathname.startsWith("/api/v1/pos/cashier-assignments/")).map((c) => [c.method, c.url.pathname.split("/").at(-1), c.body]);
    expect(writes).toEqual([
      ["PUT", "u-new", { locationId: "loc-b" }],
      ["PUT", "u-cash", { locationId: "loc-b" }],
      ["DELETE", "u-cash", undefined],
    ]);
  });
});
