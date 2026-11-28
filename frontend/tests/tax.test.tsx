// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations } from "./support/catalog";
import { posted } from "./support/money";
import { installTaxServer, queried, showTax, type TaxServer } from "./support/tax";

// KRA eTIMS & tax (Wave 4 part B): the fiscal-invoice dashboard by status with an invoice's KRA
// artefacts; resubmitting a rejected invoice and filing a credit note (owner, accountant); filing
// a sale after the fact; the device; the "eTIMS not set up" path, which always names the next step;
// and the VAT return or Turnover Tax position, chosen by the business's regime.

vi.mock("next/navigation", () => ({ usePathname: () => "/tax", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

let server: TaxServer;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type User = ReturnType<typeof userEvent.setup>;
async function tab(user: User, name: string) {
  await user.click(await screen.findByRole("tab", { name }));
}
const tabNames = () => screen.getAllByRole("tab").map((t) => t.textContent);

describe("the fiscal invoices", () => {
  it("lists the invoices, filters by status and shows a signed invoice's KRA artefacts", async () => {
    server = installTaxServer();
    const user = userEvent.setup();
    showTax("VIEWER_AUDITOR");
    const list = await screen.findByRole("list", { name: "Fiscal invoices" });
    expect(within(list).getAllByRole("button")).toHaveLength(2);
    expect(await axeViolations()).toEqual([]);

    await user.selectOptions(screen.getByLabelText("Status"), "REJECTED");
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Fiscal invoices" })).getAllByRole("button")).toHaveLength(1));
    expect(queried(server, "/etims/invoices").at(-1)).toEqual({ status: "REJECTED" });
    expect(screen.getByText(/fix the cause, then resubmit/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Invoice 2 · Sale invoice · SALE-20261105-000006 · Rejected by KRA/ })).toHaveTextContent("Buyer PIN is invalid");

    await user.selectOptions(screen.getByLabelText("Status"), "SIGNED");
    await user.click(await screen.findByRole("button", { name: /Invoice 1 · Sale invoice/ }));
    const sheet = await screen.findByRole("dialog", { name: "KRA fiscal invoice" });
    expect(await within(sheet).findByText("KRA-RCPT-1")).toBeInTheDocument();
    expect(within(sheet).getByText("SIGN1ABCDEF0123456789")).toBeInTheDocument();
    expect(within(sheet).getByText("20261105143000")).toBeInTheDocument();
    const qr = within(sheet).getByRole("link", { name: /Open KRA’s check/ });
    expect(qr).toHaveAttribute("href", expect.stringContaining("etims-sbx.kra.go.ke"));
    expect(qr).toHaveAttribute("rel", "noopener noreferrer");
    // The auditor reads; correcting is the owner's and the accountant's.
    expect(within(sheet).queryByRole("button", { name: "File a credit note" })).not.toBeInTheDocument();
    expect(tabNames()).toEqual(["Fiscal invoices", "VAT / TOT return"]);
  });

  it("lets the accountant resubmit a rejected invoice, keeping its number", async () => {
    server = installTaxServer();
    const user = userEvent.setup();
    showTax("ACCOUNTANT");
    await user.click(await screen.findByRole("button", { name: /Invoice 2 ·/ }));
    const sheet = await screen.findByRole("dialog", { name: "KRA fiscal invoice" });
    expect(await within(sheet).findByText("910 · Buyer PIN is invalid")).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Resubmit to KRA" }));
    expect(await within(sheet).findByText("Invoice 2 is now signed by KRA.")).toBeInTheDocument();
    expect(posted(server, "/etims/invoices/inv-2/retry")).toHaveLength(1);
    expect(await within(sheet).findByText("KRA-RCPT-2")).toBeInTheDocument();
  });

  it("gives a manager no resubmit and no credit note", async () => {
    server = installTaxServer();
    const user = userEvent.setup();
    showTax("MSME_MANAGER");
    await user.click(await screen.findByRole("button", { name: /Invoice 2 ·/ }));
    const sheet = await screen.findByRole("dialog", { name: "KRA fiscal invoice" });
    await within(sheet).findByText("910 · Buyer PIN is invalid");
    expect(within(sheet).queryByRole("button", { name: "Resubmit to KRA" })).not.toBeInTheDocument();
    expect(tabNames()).toEqual(["Fiscal invoices", "File a sale", "VAT / TOT return"]);
  });

  it("files a credit note for a signed sale, with a reason, and then shows it on record", async () => {
    server = installTaxServer();
    const user = userEvent.setup();
    showTax("MSME_OWNER");
    await user.click(await screen.findByRole("button", { name: /Invoice 1 ·/ }));
    const sheet = await screen.findByRole("dialog", { name: "KRA fiscal invoice" });
    await user.click(await within(sheet).findByRole("button", { name: "File a credit note" }));
    await user.click(within(sheet).getByRole("button", { name: "Yes, file it" }));
    expect(within(sheet).getByText("Give a reason — KRA records why the sale is reversed.")).toBeInTheDocument();
    expect(posted(server, "/etims/sales/s-5/credit-note")).toHaveLength(0);
    await user.type(within(sheet).getByLabelText("Reason for the credit note"), "Goods returned");
    await user.click(within(sheet).getByRole("button", { name: "Yes, file it" }));
    expect(await within(sheet).findByText("Credit note 3: signed by kra.")).toBeInTheDocument();
    expect(posted(server, "/etims/sales/s-5/credit-note")).toEqual([{ reason: "Goods returned" }]);
    expect(await within(sheet).findByText(/A credit note \(invoice 3, signed by kra\) reverses this sale/)).toBeInTheDocument();
  });
});

describe("filing a sale", () => {
  it("finds a completed sale and files it with KRA, then shows the signed invoice", async () => {
    server = installTaxServer();
    const user = userEvent.setup();
    showTax("MSME_MANAGER");
    await tab(user, "File a sale");
    await user.type(screen.getByLabelText("Sale number"), "SALE-20261105");
    const found = await screen.findByRole("list", { name: "Sales found" });
    expect(queried(server, "/pos/sales").at(-1)).toEqual({ q: "SALE-20261105", status: "COMPLETED", take: "10" });
    // Already signed: nothing to file.
    expect(within(within(found).getByRole("listitem", { name: "SALE-20261105-000005" })).queryByRole("button")).not.toBeInTheDocument();
    const fresh = within(found).getByRole("listitem", { name: "SALE-20261105-000004" });
    expect(fresh).toHaveTextContent("No KRA invoice requested");
    await user.click(within(fresh).getByRole("button", { name: "File SALE-20261105-000004 with KRA" }));
    expect(await within(fresh).findByText("Signed by KRA — invoice 3, KRA receipt KRA-RCPT-3.")).toBeInTheDocument();
    expect(posted(server, "/etims/sales/s-4/sign")).toHaveLength(1);
    expect(fresh).toHaveTextContent("Signed by KRA (eTIMS)");
    await user.click(within(fresh).getByRole("button", { name: "View the invoice" }));
    const sheet = await screen.findByRole("dialog", { name: "KRA fiscal invoice" });
    expect(await within(sheet).findByText("KRA-RCPT-3")).toBeInTheDocument();
  });

  it("says plainly when KRA was unreachable and the invoice is queued", async () => {
    server = installTaxServer({ signOutcome: "QUEUED" });
    const user = userEvent.setup();
    showTax("ACCOUNTANT");
    await tab(user, "File a sale");
    await user.type(screen.getByLabelText("Sale number"), "000004");
    await user.click(await screen.findByRole("button", { name: "File SALE-20261105-000004 with KRA" }));
    expect(await screen.findByText(/queued — kra unreachable\. KRA could not be reached\. It is retried automatically with the same invoice number/)).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "SALE-20261105-000004" })).toHaveTextContent("KRA invoice pending");
  });
});

describe("when eTIMS is not set up", () => {
  it("tells the owner the next step when a sale cannot be filed, and when the device cannot be initialized", async () => {
    server = installTaxServer({ configured: false });
    const user = userEvent.setup();
    showTax("MSME_OWNER");
    await tab(user, "File a sale");
    await user.type(screen.getByLabelText("Sale number"), "000004");
    await user.click(await screen.findByRole("button", { name: "File SALE-20261105-000004 with KRA" }));
    const panel = await screen.findByRole("region", { name: "KRA eTIMS is not set up for this business yet" });
    expect(panel).toHaveTextContent("Sales still finalize normally without it");
    expect(panel).toHaveTextContent("Initialize the device on the Device tab");
    expect(panel).toHaveTextContent("Switch eTIMS on there.");
    expect(within(panel).getByRole("link", { name: "Business setup → Integrations" })).toHaveAttribute("href", "/settings?tab=integrations");

    await tab(user, "Device");
    expect(await screen.findByText("No eTIMS device yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Initialize the device" }));
    await user.click(screen.getByRole("button", { name: "Yes, initialize" }));
    expect(await screen.findByRole("region", { name: "KRA eTIMS is not set up for this business yet" })).toHaveTextContent("no active ETIMS credentials");
  });

  it("tells a manager to ask the owner", async () => {
    server = installTaxServer({ configured: false });
    const user = userEvent.setup();
    showTax("MSME_MANAGER");
    await tab(user, "File a sale");
    await user.type(screen.getByLabelText("Sale number"), "000004");
    await user.click(await screen.findByRole("button", { name: "File SALE-20261105-000004 with KRA" }));
    expect(await screen.findByRole("region", { name: "KRA eTIMS is not set up for this business yet" })).toHaveTextContent("Ask the business owner to set it up");
  });

  it("shows the empty invoice list with where an invoice comes from", async () => {
    server = installTaxServer({ configured: false });
    server.invoices.length = 0;
    showTax("ACCOUNTANT");
    expect(await screen.findByText("No KRA invoices yet")).toBeInTheDocument();
  });
});

describe("the device", () => {
  it("shows the accountant the device and gives the owner alone the initialize action", async () => {
    server = installTaxServer();
    const user = userEvent.setup();
    showTax("ACCOUNTANT");
    await tab(user, "Device");
    const dl = await screen.findByLabelText("eTIMS device");
    expect(dl).toHaveTextContent("P051234567X");
    expect(dl).toHaveTextContent("DVC-NKH-01");
    expect(screen.queryByRole("button", { name: /Initialize/ })).not.toBeInTheDocument();
    cleanup();

    showTax("MSME_OWNER");
    await tab(user, "Device");
    await screen.findByLabelText("eTIMS device");
    await user.click(screen.getByRole("button", { name: "Initialize again" }));
    await user.click(screen.getByRole("button", { name: "Yes, initialize" }));
    expect(await screen.findByText(/Device initialized with KRA \(sandbox\)/)).toBeInTheDocument();
    expect(posted(server, "/etims/device/initialize")).toHaveLength(1);
  });
});

describe("the tax return", () => {
  it("lays out a VAT return for a VAT-registered business", async () => {
    server = installTaxServer({ regime: "VAT_REGISTERED" });
    const user = userEvent.setup();
    showTax("VIEWER_AUDITOR");
    await tab(user, "VAT / TOT return");
    const doc = await screen.findByRole("region", { name: "VAT return" });
    expect(within(doc).getByRole("row", { name: /Net output VAT/ })).toHaveTextContent("15,840.00");
    expect(within(doc).getByRole("row", { name: /Net VAT · Payable to KRA/ })).toHaveTextContent("11,840.00");
    expect(within(doc).getByRole("row", { name: /B · Standard-rated/ })).toHaveTextContent("99,000.00");
    expect(within(doc).queryByText("Turnover Tax position")).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
    expect(queried(server, "/reports/vat-return").at(-1)).toEqual({});
    await user.selectOptions(screen.getByLabelText("Period", { selector: "select" }), "month");
    await user.selectOptions(screen.getByLabelText("Month"), "10");
    await waitFor(() => expect(queried(server, "/reports/vat-return").at(-1)).toMatchObject({ month: "10" }));
    expect(queried(server, "/reports/vat-return").every((q) => !("comparative" in q))).toBe(true);
    expect(screen.queryByLabelText("Compare with the period before")).not.toBeInTheDocument();
  });

  it("lays out the Turnover Tax position for a TOT business, with the anomalies the books carry", async () => {
    server = installTaxServer({ regime: "TURNOVER_TAX" });
    const user = userEvent.setup();
    showTax("MSME_OWNER");
    await tab(user, "VAT / TOT return");
    const doc = await screen.findByRole("region", { name: "Turnover Tax position" });
    expect(within(doc).getByRole("row", { name: /^Rate/ })).toHaveTextContent("3.00%");
    expect(within(doc).getByRole("row", { name: /Owed to KRA/ })).toHaveTextContent("30.00");
    expect(within(doc).getByText("Accrued equals the books")).toBeInTheDocument();
    expect(within(doc).getByRole("region", { name: "For the accountant to look at" })).toHaveTextContent("Output VAT posted while the business is not VAT registered.");
    expect(screen.queryByRole("region", { name: "VAT return" })).not.toBeInTheDocument();
  });
});
