// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { businessToday } from "@/lib/datetime";
import type { Role } from "@/lib/auth/landing";
import { axeViolations } from "./support/catalog";
import { installProcurement, installStockServer, MAIN, posts, showProcurement, type StockServer } from "./support/stock";

// Procurement (Wave 2 part B): raising a purchase order (supplier, lines in shillings), its
// lifecycle — approve, receive partly then fully, close; cancel a draft — each step role-gated and
// confirmed; the goods receipts it produces, found again from the order, with their postings read
// from the ledger; the stock it moves in; and the suppliers manager.

vi.mock("next/navigation", () => ({ usePathname: () => "/procurement", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

let server: StockServer;
const today = businessToday();

beforeEach(() => {
  server = installStockServer();
  installProcurement(server);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const send = (method: string, path: string, body?: unknown) =>
  fetch(`/api/v1${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/** An order raised and approved through the API, as another user would have. */
async function approvedOrder() {
  await send("POST", "/procurement/purchase-orders", { supplierId: "sup-1", orderDate: today, lines: [{ productId: "p-cem", quantity: "100", unitCost: "680.00" }] });
  await send("POST", "/procurement/purchase-orders/po-1/approve");
}

async function openOrder(user: ReturnType<typeof userEvent.setup>, name = "PO 0001") {
  const list = await screen.findByRole("table", { name: "Purchase orders" });
  await user.click(within(list).getByRole("button", { name }));
  return screen.findByRole("dialog", { name });
}

describe("a purchase order, end to end", () => {
  it("raise → approve → receive partly → receive the rest → close, with the stock and the GRNs", async () => {
    const user = userEvent.setup();
    showProcurement("MSME_OWNER");
    expect(await screen.findByText("No purchase orders yet")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Raise purchase order" })[0] as HTMLElement);
    let sheet = await screen.findByRole("dialog", { name: "Raise a purchase order" });

    await user.click(within(sheet).getByRole("button", { name: "Save as draft" }));
    expect(within(sheet).getByText("Choose the supplier.")).toBeInTheDocument();
    expect(within(sheet).getByText("Add at least one product.")).toBeInTheDocument();

    const supplier = within(sheet).getByLabelText("Supplier");
    await waitFor(() => expect(within(supplier).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose a supplier", "Bamburi Distributors"]));
    await user.selectOptions(supplier, "sup-1");
    await user.type(within(sheet).getByLabelText("Add a product"), "cem");
    await user.click(await within(sheet).findByRole("button", { name: /Bamburi Cement 50kg/ }));
    await user.type(within(sheet).getByLabelText("Add a product"), "nail");
    await user.click(await within(sheet).findByRole("button", { name: /Wire Nails 4in/ }));
    // Cost defaults to the catalog cost; quantities start empty.
    expect(within(sheet).getByLabelText("Bamburi Cement 50kg cost per unit (KES)")).toHaveValue("690.00");
    await user.type(within(sheet).getByLabelText("Bamburi Cement 50kg quantity"), "100");
    await user.clear(within(sheet).getByLabelText("Bamburi Cement 50kg cost per unit (KES)"));
    await user.type(within(sheet).getByLabelText("Bamburi Cement 50kg cost per unit (KES)"), "680");
    await user.type(within(sheet).getByLabelText("Wire Nails 4in quantity"), "50");
    await user.click(within(sheet).getByRole("button", { name: "Save as draft" }));

    sheet = await screen.findByRole("dialog", { name: "PO 0001" });
    expect(within(sheet).getByRole("status")).toHaveTextContent("PO 0001 saved as a draft. Approve it to send it to the supplier.");
    expect(posts(server, "/procurement/purchase-orders")).toEqual([
      { supplierId: "sup-1", orderDate: today, lines: [{ productId: "p-cem", quantity: "100", unitCost: "680.00" }, { productId: "p-nai", quantity: "50", unitCost: "150.00" }] },
    ]);
    expect(within(sheet).getByText("Draft")).toBeInTheDocument();
    expect(within(sheet).getByText("Order total").closest("tr")).toHaveTextContent("75,500.00");
    expect(within(sheet).queryByRole("button", { name: "Receive goods" })).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);

    await user.click(within(sheet).getByRole("button", { name: "Approve" }));
    await user.click(within(sheet).getByRole("button", { name: "Yes, approve" }));
    sheet = await screen.findByRole("dialog", { name: "PO 0001" });
    expect(await within(sheet).findByText("PO 0001 approved.")).toBeInTheDocument();
    expect(within(sheet).getByText("Approved")).toBeInTheDocument();

    // Partly received: 60 of the cement, none of the nails.
    await user.click(within(sheet).getByRole("button", { name: "Receive goods" }));
    sheet = await screen.findByRole("dialog", { name: "Receive goods — PO 0001" });
    expect(within(sheet).getByLabelText("Bamburi Cement 50kg received")).toHaveValue("100");
    await user.clear(within(sheet).getByLabelText("Bamburi Cement 50kg received"));
    await user.type(within(sheet).getByLabelText("Bamburi Cement 50kg received"), "150");
    await user.clear(within(sheet).getByLabelText("Wire Nails 4in received"));
    await user.type(within(sheet).getByLabelText("Wire Nails 4in received"), "0");
    await user.click(within(sheet).getByRole("button", { name: "Receive the goods" }));
    expect(within(sheet).getByText("Only 100 is still to come on this line.")).toBeInTheDocument();
    await user.clear(within(sheet).getByLabelText("Bamburi Cement 50kg received"));
    await user.type(within(sheet).getByLabelText("Bamburi Cement 50kg received"), "60");
    await user.click(within(sheet).getByRole("button", { name: "Receive the goods" }));

    sheet = await screen.findByRole("dialog", { name: "GRN 0001" });
    expect(within(sheet).getByRole("status")).toHaveTextContent("Goods received — GRN 0001.");
    expect(within(sheet).getByText("Order now").nextSibling).toHaveTextContent("Partly received");
    expect(within(sheet).getByText("Owed to the supplier for these goods").closest("tr")).toHaveTextContent("40,800.00");
    const postings = await within(sheet).findByRole("table", { name: /Entry JE-000123/ });
    expect(within(postings).getByText("1200 Inventory").closest("tr")).toHaveTextContent("40,800.00");
    expect(within(postings).getByText("2050 Goods Received Not Invoiced").closest("tr")).toHaveTextContent("40,800.00");
    expect(posts(server, "/procurement/purchase-orders/po-1/receive")).toEqual([{ lines: [{ purchaseOrderLineId: "po-1-l1", quantity: "60" }], receivingLocationId: MAIN.id, receivedAt: today }]);
    expect(server.qty("p-cem", MAIN.id)).toBe("200");

    await user.click(within(sheet).getByRole("button", { name: "Back to PO 0001" }));
    sheet = await screen.findByRole("dialog", { name: "PO 0001" });
    await waitFor(() => expect(within(sheet).getByText("Partly received")).toBeInTheDocument());
    const cement = within(sheet).getByRole("table", { name: "Ordered and received" });
    expect(within(cement).getAllByRole("row")[1]).toHaveTextContent(/Bamburi Cement 50kg.*100.*60.*40/);
    // The receipt is found again from the order.
    const receipts = await within(sheet).findByRole("list", { name: "Goods receipts" });
    expect(await within(receipts).findByRole("button", { name: /GRN 0001/ })).toBeInTheDocument();

    // The rest: 40 cement + 50 nails.
    await user.click(within(sheet).getByRole("button", { name: "Receive goods" }));
    sheet = await screen.findByRole("dialog", { name: "Receive goods — PO 0001" });
    expect(within(sheet).getByLabelText("Bamburi Cement 50kg received")).toHaveValue("40");
    expect(within(sheet).getByLabelText("Wire Nails 4in received")).toHaveValue("50");
    await user.click(within(sheet).getByRole("button", { name: "Receive the goods" }));
    sheet = await screen.findByRole("dialog", { name: "GRN 0002" });
    expect(within(sheet).getByText("Order now").nextSibling).toHaveTextContent("Received");
    expect(server.qty("p-cem", MAIN.id)).toBe("240");
    expect(server.qty("p-nai", MAIN.id)).toBe("80");

    await user.click(within(sheet).getByRole("button", { name: "Back to PO 0001" }));
    sheet = await screen.findByRole("dialog", { name: "PO 0001" });
    await user.click(await within(sheet).findByRole("button", { name: "Close order" }));
    await user.click(within(sheet).getByRole("button", { name: "Yes, close order" }));
    sheet = await screen.findByRole("dialog", { name: "PO 0001" });
    expect(await within(sheet).findByText("PO 0001 closed.")).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: /Receive goods|Approve|Close order|Cancel order|Edit the draft/ })).not.toBeInTheDocument();
  });

  it("edits a draft (the whole line set is sent) and cancels another", async () => {
    await send("POST", "/procurement/purchase-orders", { supplierId: "sup-1", orderDate: today, lines: [{ productId: "p-cem", quantity: "10", unitCost: "680.00" }] });
    const user = userEvent.setup();
    showProcurement("MSME_MANAGER");
    let sheet = await openOrder(user);
    await user.click(within(sheet).getByRole("button", { name: "Edit the draft" }));
    sheet = await screen.findByRole("dialog", { name: "Edit PO 0001" });
    const qty = within(sheet).getByLabelText("Bamburi Cement 50kg quantity");
    await user.clear(qty);
    await user.type(qty, "12.5");
    await user.click(within(sheet).getByRole("button", { name: "Save the draft" }));
    sheet = await screen.findByRole("dialog", { name: "PO 0001" });
    expect(within(sheet).getByRole("status")).toHaveTextContent("The draft was saved.");
    const patch = server.calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toEqual({ orderDate: today, lines: [{ productId: "p-cem", quantity: "12.5", unitCost: "680.00" }], supplierId: "sup-1", expectedDate: null, notes: null });

    await user.click(within(sheet).getByRole("button", { name: "Cancel order" }));
    await user.click(within(sheet).getByRole("button", { name: "Yes, cancel order" }));
    sheet = await screen.findByRole("dialog", { name: "PO 0001" });
    expect(await within(sheet).findByText("PO 0001 cancelled.")).toBeInTheDocument();
  });

  it("a supplier can be added from the order form, and is chosen", async () => {
    const user = userEvent.setup();
    showProcurement("MSME_OWNER");
    await user.click((await screen.findAllByRole("button", { name: "Raise purchase order" }))[0] as HTMLElement);
    const sheet = await screen.findByRole("dialog", { name: "Raise a purchase order" });
    await user.click(within(sheet).getByRole("button", { name: "New supplier" }));
    const form = within(sheet).getByRole("region", { name: "New supplier" });
    await user.type(within(form).getByLabelText("Supplier name"), "Mabati Rolling Mills");
    await user.click(within(form).getByRole("button", { name: "Add supplier" }));
    await waitFor(() => expect(within(sheet).getByLabelText("Supplier")).toHaveValue("sup-3"));
    expect(posts(server, "/inventory/suppliers")).toEqual([{ name: "Mabati Rolling Mills" }]);
  });

  it("filters by status, with a way back from an empty status", async () => {
    await approvedOrder();
    const user = userEvent.setup();
    showProcurement();
    await screen.findByRole("table", { name: "Purchase orders" });
    await user.selectOptions(screen.getByLabelText("Status"), "Received");
    expect(await screen.findByText("No received orders")).toBeInTheDocument();
    expect(server.calls.at(-1)?.url.search).toBe("?status=RECEIVED");
    await user.click(screen.getByRole("button", { name: "Show all orders" }));
    expect(await screen.findByRole("table", { name: "Purchase orders" })).toBeInTheDocument();
    expect(screen.getByText("1 order")).toBeInTheDocument();
  });
});

describe("suppliers", () => {
  it("lists them, adds one and edits another (including retiring it)", async () => {
    const user = userEvent.setup();
    showProcurement("MSME_OWNER");
    await user.click(await screen.findByRole("tab", { name: "Suppliers" }));
    const list = await screen.findByRole("list", { name: "Suppliers" });
    expect(within(list).getByText("Old Supplier").closest("li")).toHaveTextContent("Inactive");
    await user.click(screen.getByRole("button", { name: "Add supplier" }));
    let sheet = await screen.findByRole("dialog", { name: "Add a supplier" });
    await user.type(within(sheet).getByLabelText(/Supplier name/), "Crown Paints Ltd");
    await user.type(within(sheet).getByLabelText(/Lead time/), "two");
    await user.click(within(sheet).getByRole("button", { name: "Add supplier" }));
    expect(within(sheet).getByText("Enter whole days, e.g. 3.")).toBeInTheDocument();
    await user.clear(within(sheet).getByLabelText(/Lead time/));
    await user.type(within(sheet).getByLabelText(/Lead time/), "5");
    await user.type(within(sheet).getByLabelText(/Payment terms/), "Net 14");
    await user.click(within(sheet).getByRole("button", { name: "Add supplier" }));
    expect(await screen.findByText("Crown Paints Ltd was added.")).toBeInTheDocument();
    expect(posts(server, "/inventory/suppliers")).toEqual([{ name: "Crown Paints Ltd", paymentTerms: "Net 14", leadTimeDays: 5 }]);

    await user.click(screen.getByRole("button", { name: "Edit Bamburi Distributors" }));
    sheet = await screen.findByRole("dialog", { name: "Edit Bamburi Distributors" });
    await user.click(within(sheet).getByRole("checkbox", { name: /Active/ }));
    await user.click(within(sheet).getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Bamburi Distributors was saved.")).toBeInTheDocument();
    const patch = server.calls.find((c) => c.method === "PATCH" && c.url.pathname === "/api/v1/inventory/suppliers/sup-1");
    expect(patch?.body).toMatchObject({ name: "Bamburi Distributors", isActive: false, leadTimeDays: 3 });
  });
});

describe("role-adaptive", () => {
  it("warehouse staff receive an approved order but cannot raise, approve, close or keep suppliers", async () => {
    await approvedOrder();
    const user = userEvent.setup();
    showProcurement("WAREHOUSE_STAFF");
    expect(screen.queryByRole("tab", { name: "Suppliers" })).not.toBeInTheDocument();
    let sheet = await openOrder(user);
    expect(screen.queryByRole("button", { name: "Raise purchase order" })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: /Approve|Close order|Cancel order/ })).not.toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Receive goods" }));
    sheet = await screen.findByRole("dialog", { name: "Receive goods — PO 0001" });
    await user.click(within(sheet).getByRole("button", { name: "Receive the goods" }));
    sheet = await screen.findByRole("dialog", { name: "GRN 0001" });
    expect(within(sheet).getByText(/Your role does not open ledger entries/)).toBeInTheDocument();
    expect(server.calls.some((c) => c.url.pathname.startsWith("/api/v1/ledger"))).toBe(false);
    expect(server.calls.some((c) => c.url.pathname === "/api/v1/inventory/suppliers")).toBe(false);
  });

  it("an accountant and an auditor only read", async () => {
    await approvedOrder();
    for (const role of ["ACCOUNTANT", "VIEWER_AUDITOR"] as Role[]) {
      const user = userEvent.setup();
      showProcurement(role);
      const sheet = await openOrder(user);
      await within(sheet).findByRole("table", { name: "Ordered and received" });
      for (const name of ["Receive goods", "Approve", "Cancel order", "Close order", "Edit the draft"]) expect(within(sheet).queryByRole("button", { name }), `${role}: ${name}`).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Raise purchase order" })).not.toBeInTheDocument();
      expect(screen.queryByRole("tab", { name: "Suppliers" })).not.toBeInTheDocument();
      cleanup();
    }
  });

  it("a manager approves and closes like the owner", async () => {
    await approvedOrder();
    const user = userEvent.setup();
    showProcurement("MSME_MANAGER");
    const sheet = await openOrder(user);
    expect(within(sheet).getByRole("button", { name: "Receive goods" })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Cancel order" })).toBeInTheDocument();
  });
});
