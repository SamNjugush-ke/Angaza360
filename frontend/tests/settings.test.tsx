// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations } from "./support/catalog";
import { posted, refusal } from "./support/money";
import { installSettingsServer, showSettings, type SettingsServer } from "./support/settings";

// Business setup (Wave 5 part B): the profile and tax regime (owner writes; manager, accountant
// and auditor read), branding with a live receipt-header preview, the statutory schedules
// (current, history, supersede from a future date), and the owner-only integrations — secrets
// sent once and never shown, activation, and the Go-Live switch the server refuses until a
// production credential is active.

vi.mock("next/navigation", () => ({ usePathname: () => "/settings", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

let server: SettingsServer;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type User = ReturnType<typeof userEvent.setup>;
const tab = async (user: User, name: string) => user.click(await screen.findByRole("tab", { name }));
const tabNames = () => screen.getAllByRole("tab").map((t) => t.textContent);
const requested = (path: string) => server.calls.some((c) => c.url.pathname === `/api/v1${path}`);
const nextYear = () => (new Date().getUTCFullYear() + 1).toString();

describe("who sees what", () => {
  it("gives the manager the profile, branding and statutory as facts, and no integrations", async () => {
    server = installSettingsServer();
    const user = userEvent.setup();
    showSettings("MSME_MANAGER", "integrations");
    expect(tabNames()).toEqual(["Business profile", "Branding", "Statutory"]);
    // A deep link to a tab the role cannot open lands on the profile.
    expect(await screen.findByLabelText("Business profile details")).toHaveTextContent("Turnover Tax (TOT)");
    expect(screen.getByText(/Only the business owner can change these/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save the profile" })).not.toBeInTheDocument();

    await tab(user, "Branding");
    expect(await screen.findByLabelText("Branding details")).toHaveTextContent("Not set");
    expect(screen.queryByRole("button", { name: "Save branding" })).not.toBeInTheDocument();

    await tab(user, "Statutory");
    expect(await screen.findByLabelText("Statutory schedule KE-2026-02")).toHaveTextContent("16%");
    expect(screen.queryByRole("button", { name: "Set new rates from a future date" })).not.toBeInTheDocument();
    expect(requested("/integrations")).toBe(false);
    expect(server.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(await axeViolations()).toEqual([]);
  });

  it("lets the accountant and the auditor read the profile, the auditor without the statutory tab", async () => {
    server = installSettingsServer();
    showSettings("ACCOUNTANT");
    expect(tabNames()).toEqual(["Business profile", "Branding", "Statutory"]);
    expect(await screen.findByLabelText("Business profile details")).toHaveTextContent("Turnover Tax (TOT)");
    cleanup();
    showSettings("VIEWER_AUDITOR");
    expect(tabNames()).toEqual(["Business profile", "Branding"]);
    expect(await screen.findByLabelText("Business profile details")).toHaveTextContent("Not set");
  });

  it("opens the integrations straight from the eTIMS link for the owner", async () => {
    server = installSettingsServer();
    showSettings("MSME_OWNER", "integrations");
    expect(tabNames()).toEqual(["Business profile", "Branding", "Statutory", "Integrations"]);
    expect(screen.getByRole("tab", { name: "Integrations" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("region", { name: "KRA eTIMS (OSCU)" })).toBeInTheDocument();
  });
});

describe("the business profile", () => {
  it("checks the KRA PIN, saves the receipt identity, and confirms a regime change", async () => {
    server = installSettingsServer();
    const user = userEvent.setup();
    showSettings();
    const pin = await screen.findByLabelText(/KRA PIN/);
    await user.type(pin, "P05");
    await user.type(screen.getByLabelText(/Registered \(legal\) name/), "Nakuru Hardware Ltd");
    await user.type(screen.getByLabelText(/Address/), "Kenyatta Ave, Nakuru");
    await user.type(screen.getByLabelText(/^Phone/), "0712345678");
    await user.click(screen.getByRole("button", { name: "Save the profile" }));
    expect(screen.getByText(/A KRA PIN is a letter, nine digits and a letter/)).toBeInTheDocument();
    expect(posted(server, "/settings/business-profile", "PUT")).toEqual([]);

    await user.clear(pin);
    await user.type(pin, "p051234567x");
    await user.click(screen.getByRole("button", { name: "Save the profile" }));
    expect(await screen.findByText(/Receipts print the new details/)).toBeInTheDocument();
    expect(posted(server, "/settings/business-profile", "PUT")).toEqual([
      { taxRegime: "TURNOVER_TAX", kraPin: "P051234567X", legalName: "Nakuru Hardware Ltd", addressLine: "Kenyatta Ave, Nakuru", phone: "0712345678", email: null, receiptFooter: null, showLogoOnReceipt: true },
    ]);

    await user.selectOptions(screen.getByLabelText("Tax regime"), "VAT_REGISTERED");
    expect(screen.getByText(/shows the VAT return/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save the profile" }));
    const ask = screen.getByRole("alertdialog", { name: "Change the tax regime from Turnover Tax (TOT) to VAT registered?" });
    expect(ask).toHaveTextContent("Nothing already posted changes");
    await user.click(within(ask).getByRole("button", { name: "Yes, change the regime" }));
    expect(await screen.findByText(/The business is now VAT registered/)).toBeInTheDocument();
    expect(posted(server, "/settings/business-profile", "PUT").at(-1)).toMatchObject({ taxRegime: "VAT_REGISTERED", kraPin: "P051234567X" });
    expect(screen.getByLabelText("Tax regime")).toHaveValue("VAT_REGISTERED");
    expect(await axeViolations()).toEqual([]);
  });

  it("keeps everything typed when the server refuses", async () => {
    server = installSettingsServer();
    server.routes.push((call) => (call.method === "PUT" && call.url.pathname === "/api/v1/settings/business-profile" ? refusal(400, "body/email Invalid email address") : null));
    const user = userEvent.setup();
    showSettings();
    await user.type(await screen.findByLabelText(/Receipt footer/), "Asante sana");
    await user.click(screen.getByRole("button", { name: "Save the profile" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email address");
    expect(screen.getByLabelText(/Receipt footer/)).toHaveValue("Asante sana");
  });
});

describe("branding", () => {
  it("previews the receipt header live and saves the colour and logo", async () => {
    server = installSettingsServer();
    server.profile = { ...server.profile, legalName: "Nakuru Hardware Ltd", kraPin: "P051234567X" };
    const user = userEvent.setup();
    showSettings();
    await tab(user, "Branding");
    const preview = await screen.findByRole("region", { name: "Receipt header preview" });
    await waitFor(() => expect(preview).toHaveTextContent("Nakuru Hardware Ltd"));
    expect(preview).toHaveTextContent("KRA PIN P051234567X");

    await user.type(screen.getByLabelText(/Brand colour/), "#1f7a4d");
    expect(within(preview).getByTestId("preview-header")).toHaveStyle({ borderColor: "#1f7a4d" });
    await user.type(screen.getByLabelText(/Logo address/), "http://example.com/logo.png");
    await user.click(screen.getByRole("button", { name: "Save branding" }));
    expect(screen.getByText("The logo address must start with https://.")).toBeInTheDocument();
    expect(within(preview).queryByRole("img")).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText(/Logo address/));
    await user.type(screen.getByLabelText(/Logo address/), "https://cdn.example.com/logo.png");
    expect(preview.querySelector("img")).toHaveAttribute("src", "https://cdn.example.com/logo.png");
    await user.click(screen.getByRole("button", { name: "Save branding" }));
    expect(await screen.findByText(/Branding saved/)).toBeInTheDocument();
    expect(posted(server, "/settings/branding", "PUT")).toEqual([{ brandPrimaryColor: "#1F7A4D", brandLogoUrl: "https://cdn.example.com/logo.png" }]);
  });
});

describe("statutory schedules", () => {
  it("shows the version in force and the history, and supersedes from a future date", async () => {
    server = installSettingsServer();
    const user = userEvent.setup();
    showSettings();
    await tab(user, "Statutory");
    const facts = await screen.findByLabelText("Statutory schedule KE-2026-02");
    expect(facts).toHaveTextContent("16% — VAT Act 2013 s.5(2)(b)");
    expect(facts).toHaveTextContent("KES 2,400.00");
    expect(screen.getByRole("table", { name: /PAYE bands/ })).toHaveTextContent("and above");
    expect(within(screen.getByRole("list", { name: "Statutory versions" })).getByText(/system default · in force/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Set new rates from a future date" }));
    const form = screen.getByRole("form", { name: "New statutory version" });
    expect(within(form).getByLabelText("Personal relief (KES / month)")).toHaveValue("2400.00");
    await user.clear(within(form).getByLabelText("Turnover Tax rate (%)"));
    await user.type(within(form).getByLabelText("Turnover Tax rate (%)"), "1.5");
    await user.type(within(form).getByLabelText("Takes effect from"), "2026-01-01");
    await user.click(within(form).getByRole("button", { name: "Check and save" }));
    expect(within(form).getByText(/Choose a date after today/)).toBeInTheDocument();

    // The server's forward-only refusal keeps every figure.
    server.routes.push((call) => (call.method === "POST" && server.calls.filter((c) => c.method === "POST").length === 1 ? refusal(409, "The new version must take effect after 2026-11-05.") : null));
    await user.clear(within(form).getByLabelText("Takes effect from"));
    await user.type(within(form).getByLabelText("Takes effect from"), `${nextYear()}-01-01`);
    await user.click(within(form).getByRole("button", { name: "Check and save" }));
    await user.click(within(form).getByRole("button", { name: "Yes, save the new version" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("must take effect after 2026-11-05");
    expect(within(form).getByLabelText("Turnover Tax rate (%)")).toHaveValue("1.5");

    await user.click(within(form).getByRole("button", { name: "Check and save" }));
    await user.click(within(form).getByRole("button", { name: "Yes, save the new version" }));
    expect(await screen.findByText(new RegExp(`Version KE-${nextYear()}-01-01 takes effect`))).toBeInTheDocument();
    const sent = posted(server, "/settings/statutory-schedules").at(-1);
    expect(sent).toMatchObject({
      effectiveFrom: `${nextYear()}-01-01`,
      totRatePercent: "1.5",
      vatStandardRate: "16",
      personalRelief: "2400.00",
      nssfUpperLimit: "108000.00",
      bands: [
        { lowerBound: "0.00", upperBound: "24000.00", ratePercent: "10" },
        { lowerBound: "24000.00", upperBound: "32333.00", ratePercent: "25" },
        { lowerBound: "32333.00", upperBound: null, ratePercent: "30" },
      ],
    });
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Statutory versions" })).getByText(/set by the owner · upcoming/)).toBeInTheDocument());
  });
});

describe("integrations", () => {
  it("stores M-Pesa sandbox credentials write-only, activates them, and switches the provider on", async () => {
    server = installSettingsServer();
    const user = userEvent.setup();
    showSettings("MSME_OWNER", "integrations");
    const mpesa = await screen.findByRole("region", { name: "M-Pesa (Daraja)" });
    expect(within(screen.getByRole("region", { name: "Stripe" })).getByText(/Not available yet/)).toBeInTheDocument();
    expect(mpesa).toHaveTextContent("M-Pesa (Daraja) is off, using sandbox (testing).");

    await user.click(within(mpesa).getByRole("button", { name: "Store M-Pesa (Daraja) Sandbox (testing) credentials" }));
    const form = within(mpesa).getByRole("form", { name: "M-Pesa (Daraja) Sandbox (testing) credentials" });
    expect(form).toHaveTextContent("never shown again");
    const secret = within(form).getByLabelText("Consumer secret");
    expect(secret).toHaveAttribute("type", "password");
    await user.click(within(form).getByRole("button", { name: "Store securely" }));
    expect(within(form).getByText("Enter the passkey.")).toBeInTheDocument();

    await user.type(within(form).getByLabelText("Consumer key"), "DUMMY-KEY");
    await user.type(secret, "DUMMY-SECRET-123");
    await user.type(within(form).getByLabelText("Shortcode (till or paybill)"), "174379");
    await user.type(within(form).getByLabelText("Passkey"), "DUMMY-PASSKEY-456");
    await user.click(within(form).getByRole("button", { name: "Store securely" }));
    expect(await within(mpesa).findByText(/credentials stored — not in use until you activate them/)).toBeInTheDocument();
    expect(posted(server, "/integrations/MPESA/credentials", "PUT")).toEqual([
      { environment: "SANDBOX", fields: { consumerKey: "DUMMY-KEY", consumerSecret: "DUMMY-SECRET-123", shortcode: "174379", passkey: "DUMMY-PASSKEY-456" } },
    ]);
    // Never shown back, and gone from the page.
    expect(document.body.innerHTML).not.toMatch(/DUMMY-SECRET-123|DUMMY-PASSKEY-456/);
    expect(await within(mpesa).findByText("Stored — not active yet")).toBeInTheDocument();

    await user.click(within(mpesa).getByRole("button", { name: "Activate M-Pesa (Daraja) Sandbox (testing) credentials" }));
    expect(await within(mpesa).findByText("Active")).toBeInTheDocument();
    await user.click(within(mpesa).getByRole("button", { name: "Switch M-Pesa (Daraja) on" }));
    expect(await within(mpesa).findByText("M-Pesa (Daraja) is switched on.")).toBeInTheDocument();
    expect(posted(server, "/integrations/MPESA/settings", "PUT")).toEqual([{ enabled: true }]);
    expect(await axeViolations()).toEqual([]);
  });

  it("warns before going live and shows the server's refusal when production is not active", async () => {
    server = installSettingsServer();
    const user = userEvent.setup();
    showSettings("MSME_OWNER", "integrations");
    const etims = await screen.findByRole("region", { name: "KRA eTIMS (OSCU)" });
    await user.click(within(etims).getByRole("button", { name: "Use production (go live)" }));
    const ask = within(etims).getByRole("alertdialog", { name: "Switch KRA eTIMS (OSCU) to production?" });
    expect(ask).toHaveTextContent("filed with KRA for real");
    await user.click(within(ask).getByRole("button", { name: "Yes, go live" }));
    expect(await within(etims).findByRole("alert")).toHaveTextContent("there is no ACTIVE credential for that environment");
    expect(etims).toHaveTextContent("using sandbox (testing)");
  });

  it("keeps a half-typed credential when the server refuses it", async () => {
    server = installSettingsServer();
    server.routes.push((call) => (call.method === "PUT" && call.url.pathname === "/api/v1/integrations/ETIMS/credentials" ? refusal(400, 'ETIMS credential is missing required field "apiBaseUrl".') : null));
    const user = userEvent.setup();
    showSettings("MSME_OWNER", "integrations");
    const etims = await screen.findByRole("region", { name: "KRA eTIMS (OSCU)" });
    await user.click(within(etims).getByRole("button", { name: "Store KRA eTIMS (OSCU) Sandbox (testing) credentials" }));
    const form = within(etims).getByRole("form", { name: "KRA eTIMS (OSCU) Sandbox (testing) credentials" });
    expect(within(form).queryByLabelText(/cmc/i)).not.toBeInTheDocument();
    await user.type(within(form).getByLabelText("KRA PIN (TIN)"), "P000000000W");
    await user.type(within(form).getByLabelText("Branch id"), "00");
    await user.type(within(form).getByLabelText("Device serial number"), "DUMMY-DVC-01");
    await user.type(within(form).getByLabelText("OSCU API address"), "https://etims-sbx.example.test");
    await user.type(within(form).getByLabelText(/Auth token/), "DUMMY-TOKEN");
    await user.click(within(form).getByRole("button", { name: "Store securely" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent('missing required field "apiBaseUrl"');
    expect(within(form).getByLabelText("Device serial number")).toHaveValue("DUMMY-DVC-01");
    expect(within(form).getByLabelText(/Auth token/)).toHaveValue("DUMMY-TOKEN");
  });
});
