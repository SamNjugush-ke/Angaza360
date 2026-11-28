// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@/lib/auth/landing";
import type { Product } from "@/lib/catalog/types";
import { centsToAmount } from "@/lib/money";
import { axeViolations as violations, categoriesRoute, installFetch, json, listRoute, product, refusal, showCatalog as show, type Call, type Route } from "./support/catalog";

// The catalog (Wave 1a): the server-side list (search, category, kind and status filters, with
// `active` sent as the STRING the API expects, paged on take/skip), create and edit through the
// real form (validation, the money parser, a duplicate SKU or barcode as a field error), and the
// role-adaptive controls. The BFF is stubbed at fetch.

vi.mock("next/navigation", () => ({ usePathname: () => "/products", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

/** The backend's 409 for a unique clash: the standard envelope plus the field that clashed. */
const clash = (field: "sku" | "barcode") =>
  json(409, { statusCode: 409, error: "Conflict", message: field === "sku" ? "A product with this SKU already exists." : "A product with this barcode already exists.", field });

let calls: Call[];
let routes: Route[];

beforeEach(() => {
  ({ calls, routes } = installFetch());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const listCalls = () => calls.filter((call) => call.method === "GET" && call.url.pathname === "/api/v1/products");
const lastList = () => listCalls().at(-1)?.url.searchParams;
const table = () => screen.getByRole("table", { name: "Products and services" });

describe("the catalog list", () => {
  it("lists the first page of ACTIVE products by default — active sent as the string 'true'", async () => {
    routes.push(listRoute(), categoriesRoute);
    show("MSME_OWNER");
    expect(await within(await screen.findByRole("table")).findByRole("button", { name: "Item 0" })).toBeInTheDocument();
    const params = lastList();
    expect(params?.get("active")).toBe("true");
    expect(params?.get("take")).toBe("20");
    expect(params?.get("skip")).toBe("0");
    expect(params?.has("q")).toBe(false);
    const row = within(table()).getByRole("button", { name: "Item 0" }).closest("tr") as HTMLElement;
    expect(within(row).getByText("SKU-0")).toBeInTheDocument();
    expect(within(row).getByText("845.00")).toBeInTheDocument();
    expect(within(row).getByText("Good")).toBeInTheDocument();
    expect(within(row).getByText("Standard-rated")).toBeInTheDocument();
    expect(within(row).getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Showing 1–20 of 45")).toBeInTheDocument();
    expect(await violations()).toEqual([]);
  });

  it("pages on take/skip with the filtered total", async () => {
    routes.push(listRoute(), categoriesRoute);
    const user = userEvent.setup();
    show("CASHIER");
    await within(await screen.findByRole("table")).findByRole("button", { name: "Item 0" });
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(lastList()?.get("skip")).toBe("20"));
    expect(await screen.findByText("Showing 21–40 of 45")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Showing 41–45 of 45")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("searches on the server once typing pauses, and starts again at page 1", async () => {
    routes.push(listRoute(), categoriesRoute);
    const user = userEvent.setup();
    show("MSME_OWNER");
    await within(await screen.findByRole("table")).findByRole("button", { name: "Item 0" });
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(lastList()?.get("skip")).toBe("20"));
    await user.type(screen.getByLabelText("Search"), "cement");
    await waitFor(() => expect(lastList()?.get("q")).toBe("cement"));
    expect(lastList()?.get("skip")).toBe("0");
    // Debounced: no request was made for a half-typed word.
    expect(listCalls().filter((call) => call.url.searchParams.get("q") === "cem")).toHaveLength(0);
  });

  it("filters by category, kind and status — Inactive sends 'false', All sends no active", async () => {
    routes.push(listRoute(), categoriesRoute);
    const user = userEvent.setup();
    show("MSME_OWNER");
    await within(await screen.findByRole("table")).findByRole("button", { name: "Item 0" });
    await waitFor(() => expect(within(screen.getByLabelText("Category")).getByRole("option", { name: "Paint" })).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText("Category"), "Paint");
    await waitFor(() => expect(lastList()?.get("category")).toBe("Paint"));
    await user.selectOptions(screen.getByLabelText("Kind"), "SERVICE");
    await waitFor(() => expect(lastList()?.get("kind")).toBe("SERVICE"));
    await user.selectOptions(screen.getByLabelText("Status"), "false");
    await waitFor(() => expect(lastList()?.get("active")).toBe("false"));
    await user.selectOptions(screen.getByLabelText("Status"), "");
    await waitFor(() => expect(lastList()?.has("active")).toBe(false));
    expect(lastList()?.get("category")).toBe("Paint");
  });

  it("says so when nothing matches, and Clear filters goes back to the active list", async () => {
    routes.push((call) => (call.url.searchParams.get("q") === "zzz" ? listRoute([], 0)(call) : null), listRoute(), categoriesRoute);
    const user = userEvent.setup();
    show("MSME_OWNER");
    await within(await screen.findByRole("table")).findByRole("button", { name: "Item 0" });
    await user.type(screen.getByLabelText("Search"), "zzz");
    expect(await screen.findByText("No products match")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByLabelText("Search")).toHaveValue("");
    expect(screen.getByLabelText("Status")).toHaveValue("true");
    // The unfiltered active list comes back (served from the cache it was first read into).
    expect(await within(await screen.findByRole("table")).findByRole("button", { name: "Item 0" })).toBeInTheDocument();
  });

  it("an empty catalog invites a writer to add the first product", async () => {
    routes.push(listRoute([], 0), categoriesRoute);
    show("WAREHOUSE_STAFF");
    expect(await screen.findByText("No products yet")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Add product/ }).length).toBeGreaterThan(0);
  });

  it("shows the error state with a retry", async () => {
    let fail = true;
    routes.push((call) => (call.url.pathname === "/api/v1/products" && fail ? refusal(500, "Database unavailable.") : null), listRoute(), categoriesRoute);
    const user = userEvent.setup();
    show("MSME_OWNER");
    expect(await screen.findByText("Couldn’t load the catalog", {}, { timeout: 5000 })).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await within(await screen.findByRole("table")).findByRole("button", { name: "Item 0" })).toBeInTheDocument();
  });
});

describe("adding a product", () => {
  async function openCreate(role: Role) {
    routes.push(listRoute(), categoriesRoute);
    const user = userEvent.setup();
    show(role);
    await within(await screen.findByRole("table")).findByRole("button", { name: "Item 0" });
    await user.click(screen.getByRole("button", { name: "Add product" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a product or service" });
    return { user, dialog };
  }

  it("validates before sending: required fields and amounts in shillings", async () => {
    const { user, dialog } = await openCreate("MSME_OWNER");
    await user.type(within(dialog).getByLabelText("Selling price (KES)"), "12.345");
    await user.click(within(dialog).getByRole("button", { name: "Add product" }));
    expect(await within(dialog).findByText("Enter a SKU — the code you use for this item.")).toBeInTheDocument();
    expect(within(dialog).getByText("Enter the product name.")).toBeInTheDocument();
    expect(within(dialog).getByText("Enter an amount in shillings, e.g. 1,250.50.")).toBeInTheDocument();
    expect(within(dialog).getByText("Enter the cost price.")).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    expect(within(dialog).getByText(/A new product starts with zero stock/)).toBeInTheDocument();
    expect(await violations()).toEqual([]);
  });

  it("an owner sends exact decimal strings and the tax class; the new product opens", async () => {
    routes.unshift((call) => (call.method === "POST" && call.url.pathname === "/api/v1/products" ? json(201, product({ id: "p-new", sku: "NEW-1", name: "Gate Hinge", price: "125050", costPrice: "90000" })) : null));
    const { user, dialog } = await openCreate("MSME_OWNER");
    await user.type(within(dialog).getByLabelText("SKU"), "NEW-1");
    await user.type(within(dialog).getByLabelText("Name"), "Gate Hinge");
    await user.type(within(dialog).getByLabelText("Selling price (KES)"), "1,250.5");
    await user.type(within(dialog).getByLabelText("Cost price (KES)"), "900");
    await user.selectOptions(within(dialog).getByLabelText("Tax class"), "ZERO_RATED");
    await user.type(within(dialog).getByLabelText(/Category/), "Hardware");
    await user.click(within(dialog).getByRole("button", { name: "Add product" }));
    expect(await screen.findByRole("dialog", { name: "Gate Hinge" })).toBeInTheDocument();
    const post = calls.find((call) => call.method === "POST");
    expect(post?.body).toEqual({ sku: "NEW-1", name: "Gate Hinge", kind: "GOOD", price: "1250.50", costPrice: "900.00", unitOfMeasure: "unit", taxClass: "ZERO_RATED", category: "Hardware" });
    expect(await screen.findByText("Product added")).toBeInTheDocument();
  });

  it("warehouse staff can add, but get no tax-class control (the default applies)", async () => {
    routes.unshift((call) => (call.method === "POST" ? json(201, product({ id: "p-svc", name: "Delivery", kind: "SERVICE" })) : null));
    const { user, dialog } = await openCreate("WAREHOUSE_STAFF");
    expect(within(dialog).queryByLabelText("Tax class")).not.toBeInTheDocument();
    expect(within(dialog).getByText(/An owner or manager can change it/)).toBeInTheDocument();
    await user.click(within(dialog).getByLabelText(/Service/));
    expect(within(dialog).getByText(/Services carry no stock/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("SKU"), "SVC-1");
    await user.type(within(dialog).getByLabelText("Name"), "Delivery");
    await user.type(within(dialog).getByLabelText("Selling price (KES)"), "500");
    await user.type(within(dialog).getByLabelText("Cost price (KES)"), "0");
    await user.click(within(dialog).getByRole("button", { name: "Add product" }));
    await screen.findByRole("dialog", { name: "Delivery" });
    const body = calls.find((call) => call.method === "POST")?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("taxClass");
    expect(body["kind"]).toBe("SERVICE");
  });

  it("a duplicate SKU is a clear error on the SKU field, and what was typed is kept", async () => {
    routes.unshift((call) => (call.method === "POST" ? clash("sku") : null));
    const { user, dialog } = await openCreate("MSME_OWNER");
    await user.type(within(dialog).getByLabelText("SKU"), "NKH-CEM-50");
    await user.type(within(dialog).getByLabelText("Name"), "Cement again");
    await user.type(within(dialog).getByLabelText("Selling price (KES)"), "845");
    await user.type(within(dialog).getByLabelText("Cost price (KES)"), "690");
    await user.click(within(dialog).getByRole("button", { name: "Add product" }));
    expect(await within(dialog).findByText("A product with this SKU already exists.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("SKU")).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).getByLabelText("SKU")).toHaveFocus();
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Cement again");
    expect(within(dialog).getByLabelText(/Barcode/)).not.toHaveAttribute("aria-invalid");
  });

  it("a duplicate BARCODE on create lands on the barcode field, not the SKU", async () => {
    routes.unshift((call) => (call.method === "POST" ? clash("barcode") : null));
    const { user, dialog } = await openCreate("MSME_OWNER");
    await user.type(within(dialog).getByLabelText("SKU"), "BRAND-NEW-1");
    await user.type(within(dialog).getByLabelText("Name"), "Second cement");
    await user.type(within(dialog).getByLabelText("Selling price (KES)"), "845");
    await user.type(within(dialog).getByLabelText("Cost price (KES)"), "690");
    await user.type(within(dialog).getByLabelText(/Barcode/), "600111");
    await user.click(within(dialog).getByRole("button", { name: "Add product" }));
    expect(await within(dialog).findByText("A product with this barcode already exists.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Barcode/)).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).getByLabelText(/Barcode/)).toHaveFocus();
    expect(within(dialog).getByLabelText("SKU")).not.toHaveAttribute("aria-invalid");
    expect(within(dialog).getByLabelText("SKU")).toHaveValue("BRAND-NEW-1");
    expect(within(dialog).getByLabelText(/Barcode/)).toHaveValue("600111");
  });

  it("a 409 that names no field is shown as a message, never guessed onto a field", async () => {
    routes.unshift((call) => (call.method === "POST" ? refusal(409, "A product with sku or barcode already exists.") : null));
    const { user, dialog } = await openCreate("MSME_OWNER");
    await user.type(within(dialog).getByLabelText("SKU"), "X-1");
    await user.type(within(dialog).getByLabelText("Name"), "X");
    await user.type(within(dialog).getByLabelText("Selling price (KES)"), "1");
    await user.type(within(dialog).getByLabelText("Cost price (KES)"), "1");
    await user.click(within(dialog).getByRole("button", { name: "Add product" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("A product with sku or barcode already exists.");
    expect(within(dialog).getByLabelText("SKU")).not.toHaveAttribute("aria-invalid");
    expect(within(dialog).getByLabelText(/Barcode/)).not.toHaveAttribute("aria-invalid");
  });
});

describe("editing a product", () => {
  async function openEdit(role: Role, item: Product = product()) {
    routes.push(listRoute([item], 1), categoriesRoute);
    const user = userEvent.setup();
    show(role);
    await user.click(await within(await screen.findByRole("table")).findByRole("button", { name: item.name }));
    const detail = await screen.findByRole("dialog", { name: item.name });
    await user.click(within(detail).getByRole("button", { name: /Edit details/ }));
    const dialog = await screen.findByRole("dialog", { name: `Edit ${item.name}` });
    return { user, dialog };
  }

  it("prefills from cents and PATCHes only what changed — a cleared category is null", async () => {
    routes.unshift((call) => (call.method === "PATCH" ? json(200, product({ price: "90000", category: null })) : null));
    const { user, dialog } = await openEdit("MSME_MANAGER");
    expect(within(dialog).getByLabelText("Selling price (KES)")).toHaveValue("845.00");
    expect(within(dialog).getByText(/the kind is fixed/)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Tax class")).not.toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText("Selling price (KES)"));
    await user.type(within(dialog).getByLabelText("Selling price (KES)"), "900");
    await user.clear(within(dialog).getByLabelText(/Category/));
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Changes saved")).toBeInTheDocument();
    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch?.url.pathname).toBe("/api/v1/products/p-1");
    expect(patch?.body).toEqual({ price: "900.00", category: null });
  });

  it("a barcode another product uses is an error on the barcode field", async () => {
    routes.unshift((call) => (call.method === "PATCH" ? clash("barcode") : null));
    const { user, dialog } = await openEdit("WAREHOUSE_STAFF");
    await user.type(within(dialog).getByLabelText(/Barcode/), "600111");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByText("A product with this barcode already exists.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Barcode/)).toHaveValue("600111");
  });

  it("a failure is said in words, keeps the form, and offers a way out", async () => {
    routes.unshift((call) => (call.method === "PATCH" ? refusal(400, "price must not be negative.") : null));
    const { user, dialog } = await openEdit("MSME_OWNER");
    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), "Renamed");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("price must not be negative.");
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Renamed");
    expect(await screen.findByText("Changes not saved")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("dialog", { name: "Bamburi Cement 50kg" })).toBeInTheDocument();
  });
});

describe("role-adaptive controls", () => {
  it.each(["CASHIER", "VIEWER_AUDITOR"] as const)("%s sees the catalog and details but no write control", async (role) => {
    routes.push(listRoute([product()], 1), categoriesRoute);
    const user = userEvent.setup();
    show(role);
    await user.click(await within(await screen.findByRole("table")).findByRole("button", { name: "Bamburi Cement 50kg" }));
    const detail = await screen.findByRole("dialog", { name: "Bamburi Cement 50kg" });
    expect(screen.queryByRole("button", { name: /Add product/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Import/ })).not.toBeInTheDocument();
    expect(within(detail).queryByRole("button", { name: /Edit details/ })).not.toBeInTheDocument();
    expect(within(detail).getByText("845.00", { exact: false })).toBeInTheDocument();
  });

  it("warehouse staff and owners get Add product and Edit", async () => {
    for (const role of ["WAREHOUSE_STAFF", "MSME_OWNER"] as const) {
      routes.splice(0, routes.length, listRoute([product()], 1), categoriesRoute);
      const user = userEvent.setup();
      show(role);
      expect(await screen.findByRole("button", { name: "Add product" })).toBeInTheDocument();
      await user.click(await within(await screen.findByRole("table")).findByRole("button", { name: "Bamburi Cement 50kg" }));
      expect(within(await screen.findByRole("dialog")).getByRole("button", { name: /Edit details/ })).toBeInTheDocument();
      cleanup();
    }
  });
});

describe("the side sheet", () => {
  it("closes on Escape and gives focus back to what opened it", async () => {
    routes.push(listRoute([product()], 1), categoriesRoute);
    const user = userEvent.setup();
    show("MSME_OWNER");
    const opener = await within(await screen.findByRole("table")).findByRole("button", { name: "Bamburi Cement 50kg" });
    await user.click(opener);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    act(() => {
      fireEvent.keyDown(dialog, { key: "Escape" });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });
});

describe("money never goes through a JS number", () => {
  it("formats prices from cents strings and sends decimal strings", () => {
    expect(centsToAmount("125050")).toBe("1250.50");
    expect(centsToAmount("5")).toBe("0.05");
    expect(centsToAmount(-1999n)).toBe("-19.99");
  });

  it("the catalog source contains no Number(), parseFloat or parseInt", () => {
    const files: string[] = [];
    for (const dir of ["components/catalog", "lib/catalog"]) {
      for (const name of readdirSync(join(process.cwd(), dir))) {
        const full = join(process.cwd(), dir, name);
        if (statSync(full).isFile()) files.push(full);
      }
    }
    expect(files.length).toBeGreaterThan(4);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect([file, /\bNumber\(|parseFloat|parseInt/.test(source)]).toEqual([file, false]);
    }
  });
});
