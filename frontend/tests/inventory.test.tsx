// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axeViolations } from "./support/catalog";
import { installStockServer, posts, showInventory, TILL, type StockServer } from "./support/stock";

// Inventory & locations (Wave 2 part A): the stock list (all locations, one location, needs
// reordering, search), a product's split and history, the four stock moves — each posting in
// shillings and showing where stock now stands, each keeping its input when refused — the
// locations manager with its lease policy, and the valuation for the roles that may read it.

vi.mock("next/navigation", () => ({ usePathname: () => "/inventory", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

let server: StockServer;
beforeEach(() => {
  server = installStockServer();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const table = () => screen.getByRole("table", { name: "Stock" });
const rowOf = (name: string) => within(table()).getByRole("button", { name }).closest("tr") as HTMLElement;
const stockCalls = () => server.calls.filter((c) => c.url.pathname.startsWith("/api/v1/inventory/stock"));

async function choose(user: ReturnType<typeof userEvent.setup>, scope: HTMLElement, query: string, name: RegExp) {
  await user.type(within(scope).getByLabelText("Product"), query);
  await user.click(await within(scope).findByRole("button", { name }));
}

describe("the stock list", () => {
  it("shows every product business-wide, flags what needs reordering", async () => {
    showInventory();
    await screen.findByRole("table", { name: "Stock" });
    expect(rowOf("Bamburi Cement 50kg")).toHaveTextContent("150 bag");
    expect(within(rowOf("Wire Nails 4in")).getByText("Reorder")).toBeInTheDocument();
    expect(rowOf("Wire Nails 4in")).toHaveTextContent("reorder at 50");
    expect(within(rowOf("Bamburi Cement 50kg")).queryByText("Reorder")).not.toBeInTheDocument();
    expect(screen.getByText("3 products")).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it("needs reordering: the server's rule, business-wide", async () => {
    const user = userEvent.setup();
    showInventory();
    await screen.findByRole("table", { name: "Stock" });
    await user.click(screen.getByRole("checkbox", { name: "Needs reordering" }));
    await waitFor(() => expect(within(table()).getAllByRole("row")).toHaveLength(2));
    expect(rowOf("Wire Nails 4in")).toBeInTheDocument();
    expect(stockCalls().at(-1)?.url.search).toBe("?belowReorder=true");
    expect(screen.getByLabelText("Location")).toBeDisabled();
    expect(screen.getByText("Reordering is judged on the business-wide total.")).toBeInTheDocument();
  });

  it("one location shows what that location owns", async () => {
    const user = userEvent.setup();
    showInventory();
    await screen.findByRole("table", { name: "Stock" });
    await user.selectOptions(screen.getByLabelText("Location"), "Till 1");
    await waitFor(() => expect(within(table()).getAllByRole("row")).toHaveLength(2));
    expect(rowOf("Bamburi Cement 50kg")).toHaveTextContent("10");
    expect(stockCalls().at(-1)?.url.search).toBe(`?locationId=${TILL.id}`);
  });

  it("searches by name or SKU, and a search with no match can be cleared", async () => {
    const user = userEvent.setup();
    showInventory();
    await screen.findByRole("table", { name: "Stock" });
    await user.type(screen.getByLabelText("Search"), "nkh-nai");
    expect(within(table()).getAllByRole("row")).toHaveLength(2);
    expect(screen.getByText("1 of 3 products")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Search"), "zzz");
    expect(screen.getByText("No products match")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear the search" }));
    expect(within(table()).getAllByRole("row")).toHaveLength(4);
  });

  it("a product opens its split across locations and its history", async () => {
    const user = userEvent.setup();
    showInventory();
    await screen.findByRole("table", { name: "Stock" });
    await user.click(within(table()).getByRole("button", { name: "Bamburi Cement 50kg" }));
    const sheet = await screen.findByRole("dialog", { name: "Bamburi Cement 50kg" });
    const split = await within(sheet).findByRole("table", { name: "Stock by location" });
    expect(within(split).getByText("Main store").closest("tr")).toHaveTextContent("140");
    expect(within(split).getByText("Till 1").closest("tr")).toHaveTextContent("10");
    expect(within(split).getByText("All locations").closest("tr")).toHaveTextContent("150");
    expect(await within(sheet).findByText("No movements yet.")).toBeInTheDocument();
  });
});

describe("moving stock", () => {
  it("receive: picks a good, posts shillings, and shows the new stock (also in the list)", async () => {
    const user = userEvent.setup();
    showInventory();
    await screen.findByRole("table", { name: "Stock" });
    await user.click(screen.getByRole("button", { name: "Receive stock" }));
    const sheet = await screen.findByRole("dialog", { name: "Receive stock" });
    expect(within(sheet).getByText(/Goes into Main store/)).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Receive into stock" }));
    expect(within(sheet).getByText("Choose the product you are receiving.")).toBeInTheDocument();
    await choose(user, sheet, "cem", /Bamburi Cement 50kg/);
    await user.type(within(sheet).getByLabelText("Quantity (bag)"), "20");
    await user.type(within(sheet).getByLabelText("Cost per unit (KES)"), "700");
    // Only active suppliers are offered.
    const supplierPicker = await within(sheet).findByLabelText("Supplier (optional)");
    await waitFor(() => expect(within(supplierPicker).getAllByRole("option").map((o) => o.textContent)).toEqual(["No supplier recorded", "Bamburi Distributors"]));
    await user.selectOptions(supplierPicker, "sup-1");
    await user.click(within(sheet).getByRole("button", { name: "Receive into stock" }));
    expect(await within(sheet).findByRole("status")).toHaveTextContent("Received 20 bag of Bamburi Cement 50kg into Main store");
    expect(within(sheet).getByRole("status")).toHaveTextContent("Stock now 170 bag across all locations");
    expect(posts(server, "/inventory/receipts")).toEqual([{ productId: "p-cem", quantity: "20", unitCost: "700.00", supplierId: "sup-1", paidImmediately: false }]);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(rowOf("Bamburi Cement 50kg")).toHaveTextContent("170 bag"));
  });

  it("adjust down: an insufficient-stock refusal keeps the input; then a valid count posts", async () => {
    const user = userEvent.setup();
    showInventory();
    await screen.findByRole("table", { name: "Stock" });
    await user.click(within(table()).getByRole("button", { name: "Wire Nails 4in" }));
    const detail = await screen.findByRole("dialog", { name: "Wire Nails 4in" });
    await user.click(within(detail).getByRole("button", { name: "Adjust stock" }));
    const sheet = await screen.findByRole("dialog", { name: "Adjust stock — Wire Nails 4in" });
    await user.type(within(sheet).getByLabelText("Quantity (kg)"), "45");
    await user.click(within(sheet).getByRole("button", { name: "Adjust down" }));
    expect(within(sheet).getByText("Give a reason — it is kept with the movement.")).toBeInTheDocument();
    await user.type(within(sheet).getByLabelText("Reason"), "Stock-take count");
    await user.click(within(sheet).getByRole("button", { name: "Adjust down" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("Insufficient stock for NKH-NAI-4 (Wire Nails 4in) at MAIN: requested 45, available 30.");
    expect(within(sheet).getByLabelText("Quantity (kg)")).toHaveValue("45");
    expect(within(sheet).getByLabelText("Reason")).toHaveValue("Stock-take count");
    await user.clear(within(sheet).getByLabelText("Quantity (kg)"));
    await user.type(within(sheet).getByLabelText("Quantity (kg)"), "4.5");
    await user.click(within(sheet).getByRole("button", { name: "Adjust down" }));
    expect(await within(sheet).findByRole("status")).toHaveTextContent("Removed 4.5 kg of Wire Nails 4in at Main store. Stock now 25.5 kg");
    expect(posts(server, "/inventory/adjustments").at(-1)).toEqual({ productId: "p-nai", movementType: "ADJUSTMENT_DECREASE", quantity: "4.5", notes: "Stock-take count" });
  });

  it("adjust up asks what the extra stock is worth, in shillings", async () => {
    const user = userEvent.setup();
    showInventory();
    await screen.findByRole("table", { name: "Stock" });
    await user.click(screen.getByRole("button", { name: "Adjust stock" }));
    const sheet = await screen.findByRole("dialog", { name: "Adjust stock" });
    await choose(user, sheet, "paint", /Crown Paint 4L/);
    await user.click(within(sheet).getByRole("radio", { name: "Up — more than recorded" }));
    await user.type(within(sheet).getByLabelText("Quantity (tin)"), "3");
    await user.type(within(sheet).getByLabelText("Reason"), "Found in the back store");
    const value = within(sheet).getByLabelText("Value per unit (KES)");
    await user.clear(value);
    await user.type(value, "1,150.5");
    await user.click(within(sheet).getByRole("button", { name: "Adjust up" }));
    await within(sheet).findByRole("status");
    expect(posts(server, "/inventory/adjustments").at(-1)).toEqual({ productId: "p-pnt", movementType: "ADJUSTMENT_INCREASE", quantity: "3", unitCost: "1150.50", notes: "Found in the back store" });
  });

  it("write off (owner): posts the reason and shows the loss", async () => {
    const user = userEvent.setup();
    showInventory();
    await screen.findByRole("table", { name: "Stock" });
    await user.click(screen.getByRole("button", { name: "Write off stock" }));
    const sheet = await screen.findByRole("dialog", { name: "Write off stock" });
    await choose(user, sheet, "cem", /Bamburi Cement 50kg/);
    await user.type(within(sheet).getByLabelText("Quantity (bag)"), "2");
    await user.type(within(sheet).getByLabelText("Reason"), "Bags split in the rain");
    await user.click(within(sheet).getByRole("button", { name: "Write off" }));
    expect(await within(sheet).findByRole("status")).toHaveTextContent("Wrote off 2 bag of Bamburi Cement 50kg from Main store — a loss of KES 1,380.00. Stock now 148 bag");
    expect(posts(server, "/inventory/write-offs")).toEqual([{ productId: "p-cem", quantity: "2", notes: "Bags split in the rain" }]);
  });

  it("transfer: moves owned stock and shows both locations after; refuses the same place twice", async () => {
    const user = userEvent.setup();
    showInventory();
    await screen.findByRole("table", { name: "Stock" });
    await user.click(within(table()).getByRole("button", { name: "Bamburi Cement 50kg" }));
    const detail = await screen.findByRole("dialog", { name: "Bamburi Cement 50kg" });
    await user.click(within(detail).getByRole("button", { name: "Transfer stock" }));
    const sheet = await screen.findByRole("dialog", { name: "Transfer stock — Bamburi Cement 50kg" });
    expect(await within(sheet).findByText("Held now: Main store 140 · Till 1 10")).toBeInTheDocument();
    await user.selectOptions(within(sheet).getByLabelText("From"), "Main store");
    await user.selectOptions(within(sheet).getByLabelText("To"), "Main store");
    await user.type(within(sheet).getByLabelText("Quantity (bag)"), "15");
    await user.click(within(sheet).getByRole("button", { name: "Transfer" }));
    expect(within(sheet).getByText("Choose a different location from the one it leaves.")).toBeInTheDocument();
    await user.selectOptions(within(sheet).getByLabelText("To"), "Till 1");
    await user.click(within(sheet).getByRole("button", { name: "Transfer" }));
    expect(await within(sheet).findByRole("status")).toHaveTextContent("Main store now holds 125, Till 1 now holds 25. The business-wide total is unchanged (150).");
    expect(posts(server, "/inventory/transfers")).toEqual([{ productId: "p-cem", fromLocationId: "loc-main", toLocationId: "loc-till", quantity: "15" }]);
  });

  it("refuses a quantity that is not one before sending anything", async () => {
    const user = userEvent.setup();
    showInventory();
    await screen.findByRole("table", { name: "Stock" });
    await user.click(screen.getByRole("button", { name: "Receive stock" }));
    const sheet = await screen.findByRole("dialog", { name: "Receive stock" });
    await choose(user, sheet, "cem", /Bamburi Cement 50kg/);
    await user.type(within(sheet).getByLabelText("Quantity (bag)"), "1.2345");
    await user.type(within(sheet).getByLabelText("Cost per unit (KES)"), "abc");
    await user.click(within(sheet).getByRole("button", { name: "Receive into stock" }));
    expect(within(sheet).getByText("Enter a quantity, e.g. 12 or 2.5 (up to three decimals).")).toBeInTheDocument();
    expect(within(sheet).getByText("Enter an amount in shillings, e.g. 1,250.50.")).toBeInTheDocument();
    expect(posts(server, "/inventory/receipts")).toEqual([]);
  });
});

describe("locations", () => {
  it("lists each location with its policy, and adds one with an offline lease that never expires", async () => {
    const user = userEvent.setup();
    showInventory();
    await user.click(await screen.findByRole("tab", { name: "Locations" }));
    const list = await screen.findByRole("list", { name: "Locations" });
    expect(within(list).getByText("Till 1").closest("li")).toHaveTextContent("Works offline · lease 480 min");
    expect(within(list).getByText("Main store").closest("li")).toHaveTextContent("Online only");
    // MAIN cannot be deactivated.
    expect(within(list).queryByRole("button", { name: "Deactivate Main store" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add location" }));
    const sheet = await screen.findByRole("dialog", { name: "Add a location" });
    await user.type(within(sheet).getByLabelText("Name"), "Westlands Branch");
    await user.type(within(sheet).getByLabelText("Code"), "west-1");
    await user.selectOptions(within(sheet).getByLabelText("Type"), "Branch");
    await user.click(within(sheet).getByRole("checkbox", { name: /Works offline/ }));
    await user.click(within(sheet).getByRole("radio", { name: /Never expires/ }));
    await user.click(within(sheet).getByRole("button", { name: "Add location" }));
    expect(await screen.findByText("Westlands Branch was added.")).toBeInTheDocument();
    expect(posts(server, "/locations")).toEqual([{ name: "Westlands Branch", code: "WEST-1", type: "BRANCH", isOfflineCapable: true, leaseWindowMinutes: null }]);
    expect(await within(list).findByText("Westlands Branch")).toBeInTheDocument();
  });

  it("edits a lease and a session window; an online shop cannot work offline", async () => {
    const user = userEvent.setup();
    showInventory();
    await user.click(await screen.findByRole("tab", { name: "Locations" }));
    await user.click(await screen.findByRole("button", { name: "Edit Till 1" }));
    const sheet = await screen.findByRole("dialog", { name: "Edit Till 1" });
    const minutes = within(sheet).getByLabelText("Lease length (minutes)");
    await user.clear(minutes);
    await user.type(minutes, "0");
    await user.click(within(sheet).getByRole("button", { name: "Save changes" }));
    expect(within(sheet).getByText(/Enter whole minutes above 0/)).toBeInTheDocument();
    await user.clear(minutes);
    await user.type(minutes, "720");
    await user.type(within(sheet).getByLabelText("Opens"), "08:00");
    await user.click(within(sheet).getByRole("button", { name: "Save changes" }));
    expect(within(sheet).getByText("Set both the opening and closing time, or neither.")).toBeInTheDocument();
    await user.type(within(sheet).getByLabelText("Closes"), "18:30");
    await user.selectOptions(within(sheet).getByLabelText("Type"), "Online shop");
    expect(within(sheet).getByRole("checkbox", { name: /Works offline/ })).toBeDisabled();
    await user.selectOptions(within(sheet).getByLabelText("Type"), "Till");
    await user.click(within(sheet).getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Till 1 was saved.")).toBeInTheDocument();
    const patch = server.calls.find((c) => c.method === "PATCH" && c.url.pathname === "/api/v1/locations/loc-till");
    expect(patch?.body).toEqual({ name: "Till 1", type: "POS", isOfflineCapable: true, leaseWindowMinutes: 720, sessionStart: "08:00", sessionEnd: "18:30" });
  });

  it("deactivating a location that holds stock is refused with what to do; an empty one deactivates and reactivates", async () => {
    server.locations.push({ ...TILL, id: "loc-empty", name: "Old Kiosk", code: "KIOSK", isOfflineCapable: false, leaseWindowMinutes: null });
    const user = userEvent.setup();
    showInventory();
    await user.click(await screen.findByRole("tab", { name: "Locations" }));
    await user.click(await screen.findByRole("button", { name: "Deactivate Till 1" }));
    await user.click(screen.getByRole("button", { name: "Yes, deactivate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Till 1 still owns stock; transfer it out before deactivating.");
    await user.click(screen.getByRole("button", { name: "Back" }));

    await user.click(screen.getByRole("button", { name: "Deactivate Old Kiosk" }));
    await user.click(screen.getByRole("button", { name: "Yes, deactivate" }));
    expect(await screen.findByText("Old Kiosk is deactivated.")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Activate Old Kiosk" }));
    await user.click(screen.getByRole("button", { name: "Yes, activate" }));
    expect(await screen.findByText("Old Kiosk is active again.")).toBeInTheDocument();
  });
});

describe("valuation", () => {
  it("the owner reads the value, the books' figure and the location split", async () => {
    const user = userEvent.setup();
    showInventory("MSME_OWNER");
    await user.click(await screen.findByRole("tab", { name: "Valuation" }));
    const value = await screen.findByRole("region", { name: "Stock value" });
    expect(value).toHaveTextContent("KES 108,000.00"); // 150 × 690 + 30 × 150
    expect(value).toHaveTextContent("Reconciled");
    const byLocation = screen.getByRole("table", { name: "Stock value by location" });
    expect(within(byLocation).getByText("Till 1").closest("tr")).toHaveTextContent("6,900.00");
    expect(await axeViolations()).toEqual([]);
  });

  it("is hidden from a manager and offered to an accountant and an auditor", async () => {
    showInventory("MSME_MANAGER");
    await screen.findByRole("tab", { name: "Stock" });
    expect(screen.queryByRole("tab", { name: "Valuation" })).not.toBeInTheDocument();
    cleanup();
    for (const role of ["ACCOUNTANT", "VIEWER_AUDITOR"] as const) {
      showInventory(role);
      expect(await screen.findByRole("tab", { name: "Valuation" })).toBeInTheDocument();
      cleanup();
    }
    expect(server.calls.some((c) => c.url.pathname === "/api/v1/inventory/valuation")).toBe(false);
  });
});

describe("role-adaptive", () => {
  it("warehouse staff move stock but cannot write off, pick a supplier or manage locations", async () => {
    const user = userEvent.setup();
    showInventory("WAREHOUSE_STAFF");
    await screen.findByRole("table", { name: "Stock" });
    for (const name of ["Receive stock", "Adjust stock", "Transfer stock"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Write off stock" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Receive stock" }));
    const sheet = await screen.findByRole("dialog", { name: "Receive stock" });
    expect(within(sheet).queryByLabelText("Supplier (optional)")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("tab", { name: "Locations" }));
    await screen.findByRole("list", { name: "Locations" });
    expect(screen.queryByRole("button", { name: "Add location" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Edit / })).not.toBeInTheDocument();
    expect(server.calls.some((c) => c.url.pathname === "/api/v1/inventory/suppliers")).toBe(false);
  });

  it("an accountant and an auditor only read", async () => {
    for (const role of ["ACCOUNTANT", "VIEWER_AUDITOR"] as const) {
      const user = userEvent.setup();
      showInventory(role);
      await screen.findByRole("table", { name: "Stock" });
      expect(screen.queryByRole("button", { name: /Receive|Adjust|Transfer|Write off/ })).not.toBeInTheDocument();
      await user.click(within(table()).getByRole("button", { name: "Bamburi Cement 50kg" }));
      const sheet = await screen.findByRole("dialog", { name: "Bamburi Cement 50kg" });
      await within(sheet).findByRole("table", { name: "Stock by location" });
      expect(within(sheet).queryByRole("button", { name: /Receive|Adjust|Transfer|Write off/ })).not.toBeInTheDocument();
      cleanup();
    }
  });

  it("tabs move with the arrow keys", async () => {
    const user = userEvent.setup();
    showInventory();
    const stock = await screen.findByRole("tab", { name: "Stock" });
    stock.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Locations" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Locations" })).toHaveAttribute("aria-selected", "true");
  });
});
