// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@/lib/auth/landing";
import type { Product } from "@/lib/catalog/types";
import { axeViolations, catalogTable, categoriesRoute, installFetch, json, listRoute, product, refusal, showCatalog, type Call, type Route } from "./support/catalog";

// The catalog's managed settings and the CSV import (Wave 1a): the reorder policy (writers), the
// tax class and activation (owner / manager only, activation behind a confirm), and import as
// template → check (preview) → import only when every row is ready, with the chosen file kept
// through every failure.

vi.mock("next/navigation", () => ({ usePathname: () => "/products", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

let calls: Call[];
let routes: Route[];

beforeEach(() => {
  ({ calls, routes } = installFetch());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openProduct(role: Role, item: Product = product()) {
  routes.push(listRoute([item], 1), categoriesRoute);
  const user = userEvent.setup();
  showCatalog(role);
  await user.click(await (await catalogTable()).findByRole("button", { name: item.name }));
  return { user, dialog: await screen.findByRole("dialog", { name: item.name }) };
}

const sent = (method: string, suffix: string) => calls.filter((call) => call.method === method && call.url.pathname.endsWith(suffix));

describe("the reorder policy", () => {
  it("prefills, validates, and saves both figures — an empty quantity clears it", async () => {
    routes.unshift((call) => (call.method === "PATCH" ? json(200, product({ minStockThreshold: "25.000", reorderQuantity: null, updatedAt: "2026-11-03T08:00:00.000Z" })) : null));
    const { user, dialog } = await openProduct("WAREHOUSE_STAFF");
    const level = within(dialog).getByLabelText("Reorder level (bag)");
    const quantity = within(dialog).getByLabelText(/Reorder quantity \(bag\)/);
    expect(level).toHaveValue("20");
    expect(quantity).toHaveValue("100");

    await user.clear(level);
    await user.type(level, "-1");
    await user.clear(quantity);
    await user.type(quantity, "0");
    await user.click(within(dialog).getByRole("button", { name: "Save reorder policy" }));
    expect(await within(dialog).findByText("Use a number with up to 3 decimals, e.g. 20 or 2.5.")).toBeInTheDocument();
    expect(within(dialog).getByText("Leave it empty for none, or enter more than 0.")).toBeInTheDocument();
    expect(sent("PATCH", "/reorder-policy")).toHaveLength(0);

    await user.clear(level);
    await user.type(level, "25");
    await user.clear(quantity);
    await user.click(within(dialog).getByRole("button", { name: "Save reorder policy" }));
    expect(await screen.findByText("Reorder policy saved")).toBeInTheDocument();
    expect(sent("PATCH", "/p-1/reorder-policy")[0]?.body).toEqual({ minStockThreshold: "25", reorderQuantity: null });
    expect(within(screen.getByRole("dialog")).getByLabelText(/Reorder quantity/)).toHaveValue("");
  });

  it("a service has no reorder level", async () => {
    const { dialog } = await openProduct("MSME_OWNER", product({ id: "s-1", name: "Delivery", kind: "SERVICE", stockCount: "0.000" }));
    expect(within(dialog).queryByLabelText(/Reorder level/)).not.toBeInTheDocument();
    expect(within(dialog).getByText("Services carry no stock, so they have no reorder level.")).toBeInTheDocument();
  });
});

describe("the tax class", () => {
  it("an owner changes it; the details show the new class", async () => {
    routes.unshift((call) => (call.method === "PATCH" && call.url.pathname.endsWith("/tax-class") ? json(200, product({ taxClass: "EXEMPT" })) : null));
    const { user, dialog } = await openProduct("MSME_OWNER");
    const save = within(dialog).getByRole("button", { name: "Save tax class" });
    expect(save).toBeDisabled();
    await user.selectOptions(within(dialog).getByLabelText("Tax class"), "EXEMPT");
    await user.click(save);
    expect(await screen.findByText("Tax class set to Exempt")).toBeInTheDocument();
    expect(sent("PATCH", "/p-1/tax-class")[0]?.body).toEqual({ taxClass: "EXEMPT" });
    expect(within(screen.getByRole("dialog")).getAllByText("Exempt").length).toBeGreaterThan(0);
  });

  it("warehouse staff get no tax-class control and no activation", async () => {
    const { dialog } = await openProduct("WAREHOUSE_STAFF");
    expect(within(dialog).queryByLabelText("Tax class")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Deactivate/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Edit details/ })).toBeInTheDocument();
  });

  it.each(["CASHIER", "VIEWER_AUDITOR"] as const)("%s sees no reorder, tax-class or activation control", async (role) => {
    const { dialog } = await openProduct(role);
    expect(within(dialog).queryByLabelText(/Reorder level/)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Tax class")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /activate/i })).not.toBeInTheDocument();
  });
});

describe("activation", () => {
  it("deactivating asks first; Keep active changes nothing", async () => {
    const { user, dialog } = await openProduct("MSME_MANAGER");
    await user.click(within(dialog).getByRole("button", { name: "Deactivate product" }));
    const confirm = within(dialog).getByRole("alertdialog", { name: "Deactivate Bamburi Cement 50kg?" });
    expect(confirm).toHaveTextContent("Its stock stays on your books");
    await user.click(within(confirm).getByRole("button", { name: "Keep active" }));
    expect(within(dialog).queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(sent("POST", "/deactivate")).toHaveLength(0);
  });

  it("confirmed, it POSTs with no body and the status changes to Inactive", async () => {
    routes.unshift((call) => (call.method === "POST" && call.url.pathname.endsWith("/deactivate") ? json(200, product({ isActive: false })) : null));
    const { user, dialog } = await openProduct("MSME_OWNER");
    await user.click(within(dialog).getByRole("button", { name: "Deactivate product" }));
    await user.click(within(dialog).getByRole("button", { name: "Yes, deactivate" }));
    expect(await screen.findByText("Product deactivated")).toBeInTheDocument();
    const post = sent("POST", "/p-1/deactivate")[0];
    expect(post?.body).toBeUndefined();
    const updated = screen.getByRole("dialog");
    expect(within(updated).getByText("Inactive")).toBeInTheDocument();
    expect(within(updated).getByRole("button", { name: "Reactivate product" })).toBeInTheDocument();
  });

  it("reactivates an inactive product, and a refusal is said in words", async () => {
    routes.unshift((call) => (call.method === "POST" && call.url.pathname.endsWith("/reactivate") ? refusal(409, "The product is already active.") : null));
    const { user, dialog } = await openProduct("MSME_OWNER", product({ isActive: false }));
    await user.click(within(dialog).getByRole("button", { name: "Reactivate product" }));
    await user.click(within(dialog).getByRole("button", { name: "Yes, reactivate" }));
    expect(await screen.findByText("Not reactivated")).toBeInTheDocument();
    expect(screen.getByText("The product is already active.")).toBeInTheDocument();
    expect(sent("POST", "/p-1/reactivate")).toHaveLength(1);
  });
});

const CSV = "sku,name,costPrice,price,kind,openingQty\nNEW-1,Gate Hinge,90.00,125.00,GOOD,10\nSVC-9,Fitting,0,500.00,SERVICE,\n";

describe("CSV import", () => {
  async function openImport(role: Role = "MSME_OWNER") {
    routes.push(listRoute([product()], 1), categoriesRoute);
    const user = userEvent.setup();
    showCatalog(role);
    await user.click(await screen.findByRole("button", { name: /Import/ }));
    return { user, sheet: await screen.findByRole("dialog", { name: "Import products" }) };
  }
  const choose = (user: ReturnType<typeof userEvent.setup>, sheet: HTMLElement, text = CSV) =>
    user.upload(within(sheet).getByLabelText("CSV file"), new File([text], "products.csv", { type: "text/csv" }));

  it("downloads the template", async () => {
    routes.unshift((call) => (call.url.pathname.endsWith("/import/template") ? new Response("sku,name,costPrice,price\n", { status: 200, headers: { "content-type": "text/csv" } }) : null));
    const created = vi.fn(() => "blob:template");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const { user, sheet } = await openImport("WAREHOUSE_STAFF");
    await user.click(within(sheet).getByRole("button", { name: /Download template/ }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(sent("GET", "/import/template")).toHaveLength(1);
    expect(created).toHaveBeenCalled();
  });

  it("shows each row's problems in words, offers no import, and keeps the file", async () => {
    routes.unshift((call) =>
      call.url.pathname.endsWith("/import/preview")
        ? json(200, {
            rows: [
              { rowNumber: 1, sku: "NEW-1", name: "Gate Hinge", status: "GREEN", errors: [] },
              { rowNumber: 2, sku: "SVC-9", name: "Fitting", status: "RED", errors: [{ field: "openingQty", message: "A SERVICE carries no stock." }, { field: "price", message: "Not a valid amount." }] },
            ],
            allGreen: false,
          })
        : null,
    );
    const { user, sheet } = await openImport();
    await choose(user, sheet);
    await user.click(within(sheet).getByRole("button", { name: "Check file" }));
    expect(await within(sheet).findByText("2 rows checked — 1 ready, 1 need fixing.")).toBeInTheDocument();
    expect(within(sheet).getByText("Opening quantity:")).toBeInTheDocument();
    expect(within(sheet).getByText("Selling price:")).toBeInTheDocument();
    expect(within(sheet).getByText(/Row 2/)).toHaveTextContent("SVC-9 · Fitting");
    expect(within(sheet).queryByRole("button", { name: /^Import \d/ })).not.toBeInTheDocument();
    expect(within(sheet).getByText("Chosen: products.csv")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Check again" })).toBeEnabled();
    const preview = sent("POST", "/import/preview")[0];
    expect(preview?.contentType).toBe("text/csv");
    expect(preview?.body).toBe(CSV);
    expect(await axeViolations()).toEqual([]);
  });

  it("imports only when every row is ready, then summarises and refreshes the list", async () => {
    routes.unshift((call) => {
      if (call.url.pathname.endsWith("/import/preview")) {
        return json(200, { rows: [{ rowNumber: 1, sku: "NEW-1", name: "Gate Hinge", status: "GREEN", errors: [] }, { rowNumber: 2, sku: "SVC-9", name: "Fitting", status: "GREEN", errors: [] }], allGreen: true });
      }
      if (call.url.pathname.endsWith("/import/commit")) {
        return json(201, {
          created: [
            { rowNumber: 1, productId: "n1", sku: "NEW-1", kind: "GOOD", openingStockValue: "90000" },
            { rowNumber: 2, productId: "n2", sku: "SVC-9", kind: "SERVICE", openingStockValue: "0" },
          ],
        });
      }
      return null;
    });
    const { user, sheet } = await openImport();
    const listsBefore = sent("GET", "/api/v1/products").length;
    await choose(user, sheet);
    await user.click(within(sheet).getByRole("button", { name: "Check file" }));
    await user.click(await within(sheet).findByRole("button", { name: "Import 2 products" }));
    const done = await screen.findByRole("dialog", { name: "Import complete" });
    expect(within(done).getByText("Imported 2 products — 1 goods and 1 services.")).toBeInTheDocument();
    expect(within(done).getByText(/1 started with opening stock/)).toBeInTheDocument();
    const commit = sent("POST", "/import/commit")[0];
    expect(commit?.body).toBe(CSV);
    expect(commit?.contentType).toBe("text/csv");
    await waitFor(() => expect(sent("GET", "/api/v1/products").length).toBeGreaterThan(listsBefore));
    await user.click(within(done).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("a file-level problem or a refused commit is explained, and the file stays chosen", async () => {
    let previewAnswer: Response = refusal(400, 'The file has no "price" column.');
    routes.unshift((call) => {
      if (call.url.pathname.endsWith("/import/preview")) return previewAnswer.clone();
      if (call.url.pathname.endsWith("/import/commit")) return refusal(409, "Row 1: sku already exists.");
      return null;
    });
    const { user, sheet } = await openImport();
    await choose(user, sheet);
    await user.click(within(sheet).getByRole("button", { name: "Check file" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent('The file has no "price" column.');
    expect(within(sheet).getByText("Chosen: products.csv")).toBeInTheDocument();

    previewAnswer = json(200, { rows: [{ rowNumber: 1, sku: "NEW-1", name: "Gate Hinge", status: "GREEN", errors: [] }], allGreen: true });
    await user.click(within(sheet).getByRole("button", { name: "Check again" }));
    await user.click(await within(sheet).findByRole("button", { name: "Import 1 products" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("Row 1: sku already exists. Check the file again to see what changed.");
    expect(screen.queryByRole("dialog", { name: "Import complete" })).not.toBeInTheDocument();
    expect(within(sheet).getByText("Chosen: products.csv")).toBeInTheDocument();
  });

  it("is not offered to read-only roles", async () => {
    routes.push(listRoute([product()], 1), categoriesRoute);
    showCatalog("VIEWER_AUDITOR");
    await catalogTable();
    expect(screen.queryByRole("button", { name: /Import/ })).not.toBeInTheDocument();
  });
});
