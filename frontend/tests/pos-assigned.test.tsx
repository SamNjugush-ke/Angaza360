// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axeViolations } from "./support/catalog";
import { chooseLocation, installPosFetch, json, MAIN, refusal, shift, showTill, TILL, type Call, type Route } from "./support/pos";

// M4.5 W3 at the till: a CASHIER sells from the ONE till they are assigned — shown as context,
// never offered as a choice, and used for every quote and sale even if the shell's cookie says
// otherwise; a cashier moved to another till is stopped from selling on the old shift; with no
// assignment there is a clear way forward. The stock sheet shows what is low at their till and
// sends a request that moves nothing until a manager approves it.

vi.mock("next/navigation", () => ({ usePathname: () => "/pos", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

let calls: Call[];
let routes: Route[];

beforeEach(() => {
  // The shell's working-location cookie says MAIN — a cashier's till must ignore it.
  chooseLocation(MAIN.id);
  ({ calls, routes } = installPosFetch());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  chooseLocation(null);
});

const assigned = (over: Record<string, unknown> = {}) => (call: Call) =>
  call.url.pathname === "/api/v1/pos/my-location"
    ? json(200, { restricted: true, location: { id: TILL.id, code: TILL.code, name: TILL.name, type: TILL.type }, lowStock: [], myRequests: [], ...over })
    : null;

async function addCement(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText("Scan or search products"), "cement");
  await user.click(await screen.findByRole("button", { name: /Bamburi Cement 50kg/ }));
}

describe("a cashier's till is their assigned location", () => {
  it("shows the till as context, offers no location choice, and quotes and sells from it", async () => {
    const user = userEvent.setup();
    showTill("CASHIER");
    const bar = await screen.findByText(/Shift open/);
    expect(bar.closest("p")).toHaveTextContent("Till 1");
    expect(screen.queryByText("Choose the location you are selling from")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sell from/ })).not.toBeInTheDocument();
    await addCement(user);
    await waitFor(() => expect(calls.some((c) => c.url.pathname === "/api/v1/pos/sales/quote")).toBe(true));
    const quote = calls.filter((c) => c.url.pathname === "/api/v1/pos/sales/quote").at(-1)?.body as { sellingLocationId: string };
    expect(quote.sellingLocationId).toBe(TILL.id);
    expect(await axeViolations()).toEqual([]);
  });

  it("with no assignment: says so, opens nothing, and can check again", async () => {
    let assignedNow = false;
    routes.push((call) =>
      call.url.pathname === "/api/v1/pos/my-location"
        ? json(200, { restricted: true, location: assignedNow ? { id: TILL.id, code: TILL.code, name: TILL.name, type: TILL.type } : null, lowStock: [], myRequests: [] })
        : null,
    );
    const user = userEvent.setup();
    showTill("CASHIER");
    expect(await screen.findByText("You are not assigned to a till yet")).toBeInTheDocument();
    expect(calls.some((c) => c.url.pathname === "/api/v1/pos/shifts/current")).toBe(false);
    assignedNow = true;
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText(/Shift open/)).toBeInTheDocument();
  });

  it("a cashier moved to another till cannot take payment on the old shift, and is told what to do", async () => {
    routes.push((call) => (call.url.pathname === "/api/v1/pos/shifts/current" ? json(200, shift({ locationId: MAIN.id })) : null));
    const user = userEvent.setup();
    showTill("CASHIER");
    expect(await screen.findByText("You have been moved to Till 1.")).toBeInTheDocument();
    await addCement(user);
    await waitFor(() => expect(screen.getByRole("button", { name: /Take payment/ })).toBeDisabled());
  });

  it("opens the shift without naming a location — the server opens it at the assignment", async () => {
    let open = false;
    routes.push((call) => (call.url.pathname === "/api/v1/pos/shifts/current" && !open ? refusal(404, "No open shift.") : null));
    routes.push((call) => {
      if (call.method !== "POST" || call.url.pathname !== "/api/v1/pos/shifts/open") return null;
      open = true;
      return json(201, shift());
    });
    const user = userEvent.setup();
    showTill("CASHIER");
    await user.type(await screen.findByLabelText("Cash in the drawer (KES)"), "1000");
    await user.click(screen.getByRole("button", { name: "Open shift" }));
    await screen.findByText(/Shift open/);
    expect(calls.find((c) => c.url.pathname === "/api/v1/pos/shifts/open")?.body).toEqual({ openingFloat: "1000.00" });
  });

  it("an owner or manager names the location they open the shift at", async () => {
    chooseLocation(TILL.id);
    let open = false;
    routes.push((call) => (call.url.pathname === "/api/v1/pos/shifts/current" && !open ? refusal(404, "No open shift.") : null));
    routes.push((call) => {
      if (call.method !== "POST" || call.url.pathname !== "/api/v1/pos/shifts/open") return null;
      open = true;
      return json(201, shift({ cashierAssigned: false }));
    });
    const user = userEvent.setup();
    showTill("MSME_MANAGER");
    await user.type(await screen.findByLabelText("Cash in the drawer (KES)"), "500");
    await user.click(screen.getByRole("button", { name: "Open shift" }));
    await screen.findByText(/Shift open/);
    expect(calls.find((c) => c.url.pathname === "/api/v1/pos/shifts/open")?.body).toEqual({ openingFloat: "500.00", locationId: TILL.id });
    expect(calls.some((c) => c.url.pathname === "/api/v1/pos/my-location")).toBe(false);
  });
});

const LOW = { productId: "p-nai", sku: "NKH-NAI-4", productName: "Wire Nails 4in", locationId: TILL.id, locationCode: TILL.code, locationName: TILL.name, locationType: "POS", quantity: "2.000", threshold: "5.000", shortfall: "3.000", reorderQuantity: "10.000", suggestedTransferQty: "10.000", mainAvailable: "40.000" };
const request = (over: Record<string, unknown> = {}) => ({
  id: "req-1",
  productId: "p-nai",
  sku: "NKH-NAI-4",
  productName: "Wire Nails 4in",
  locationId: TILL.id,
  locationCode: TILL.code,
  locationName: TILL.name,
  requestedQty: "10.000",
  approvedQty: null,
  status: "PENDING",
  requestedBy: "user-1",
  decidedBy: null,
  decidedAt: null,
  transferId: null,
  note: null,
  createdAt: "2026-11-16T08:00:00.000Z",
  updatedAt: "2026-11-16T08:00:00.000Z",
  ...over,
});

describe("the till's stock sheet", () => {
  it("lists what is low at the cashier's till and sends a request for it — moving nothing", async () => {
    const mine: Array<Record<string, unknown>> = [];
    routes.push((call) => (call.url.pathname === "/api/v1/pos/my-location" ? assigned({ lowStock: [LOW], myRequests: mine })(call) : null));
    routes.push((call) => {
      if (call.method !== "POST" || call.url.pathname !== "/api/v1/allocations/requests") return null;
      const sent = request({ requestedQty: "10" });
      mine.push(sent);
      return json(201, sent);
    });
    const user = userEvent.setup();
    showTill("CASHIER");
    await user.click(await screen.findByRole("button", { name: /Stock & requests/ }));
    const sheet = await screen.findByRole("dialog", { name: "Stock at your till" });
    const low = await within(sheet).findByText("Wire Nails 4in");
    expect(low.closest("li")).toHaveTextContent("2 left · reorder at 5");
    await user.click(within(sheet).getByRole("button", { name: "Request more" }));
    expect(within(sheet).getByLabelText("How many")).toHaveValue("10");
    await user.click(within(sheet).getByRole("button", { name: "Send the request" }));
    expect(await within(sheet).findByText(/no stock has moved yet/)).toBeInTheDocument();
    expect(calls.find((c) => c.url.pathname === "/api/v1/allocations/requests")?.body).toEqual({ productId: "p-nai", locationId: TILL.id, requestedQty: "10" });
    expect(await within(sheet).findByText("Waiting for a decision", { exact: false })).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it("shows the server's refusal and keeps the form", async () => {
    routes.push(assigned({ lowStock: [LOW] }));
    routes.push((call) => (call.method === "POST" && call.url.pathname === "/api/v1/allocations/requests" ? refusal(403, "You may sell only from your assigned location, Till 1.") : null));
    const user = userEvent.setup();
    showTill("CASHIER");
    await user.click(await screen.findByRole("button", { name: /Stock & requests/ }));
    const sheet = await screen.findByRole("dialog", { name: "Stock at your till" });
    await user.click(await within(sheet).findByRole("button", { name: "Request more" }));
    await user.click(within(sheet).getByRole("button", { name: "Send the request" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("only from your assigned location");
    expect(within(sheet).getByLabelText("How many")).toHaveValue("10");
  });

  it("a pending request can be withdrawn; a decided one cannot", async () => {
    const mine = [request(), request({ id: "req-2", status: "APPROVED", approvedQty: "6.000" })];
    routes.push((call) => (call.url.pathname === "/api/v1/pos/my-location" ? assigned({ myRequests: mine })(call) : null));
    routes.push((call) => {
      if (call.method !== "POST" || call.url.pathname !== "/api/v1/allocations/requests/req-1/cancel") return null;
      mine[0] = request({ status: "CANCELLED" });
      return json(200, mine[0]);
    });
    const user = userEvent.setup();
    showTill("CASHIER");
    await user.click(await screen.findByRole("button", { name: /Stock & requests/ }));
    const sheet = await screen.findByRole("dialog", { name: "Stock at your till" });
    expect(await within(sheet).findByText(/Approved — stock sent \(6 sent\)/)).toBeInTheDocument();
    expect(within(sheet).getAllByRole("button", { name: "Withdraw" })).toHaveLength(1);
    await user.click(within(sheet).getByRole("button", { name: "Withdraw" }));
    expect(await within(sheet).findByText(/is withdrawn\. Nothing was moved\./)).toBeInTheDocument();
    await waitFor(() => expect(within(sheet).queryByRole("button", { name: "Withdraw" })).not.toBeInTheDocument());
  });
});
