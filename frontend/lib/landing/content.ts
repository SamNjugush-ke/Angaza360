// THE PUBLIC SITE'S PRODUCT STORY, AS DATA (M4.5 W3). One list of capabilities, each marked
// `available` or `coming`: the landing shows "Available now" and "Coming next" straight from it, so
// when a coming capability ships, its `status` changes here and nothing else does. A `coming` item
// is NEVER offered as something to switch on - it has no link, button or sign-up of its own.
// Every sentence is true of the product today; nothing here is a testimonial, a certification or a
// screenshot. Copy rules (the landing's brand law): no arrows, no mid-dots, no caps eyebrows.

import { PRODUCT_NAME } from "@/lib/brand";

export type Availability = "available" | "coming";

export interface Capability {
  id: string;
  name: string;
  summary: string;
  status: Availability;
}

export const CAPABILITIES: readonly Capability[] = [
  { id: "pos", name: "Point of sale and sales", status: "available", summary: "Ring sales at each till in cash, M-Pesa, bank transfer or on credit, print the receipt, and close the shift against the cash you count." },
  { id: "inventory", name: "Inventory and stock", status: "available", summary: "Stock held by each location, transfers between them, reorder levels, and stock valued to the cent against your books." },
  { id: "procurement", name: "Procurement", status: "available", summary: "Purchase orders, deliveries received against them, and supplier bills matched to what actually arrived." },
  { id: "accounting", name: "Accounting and reports", status: "available", summary: "A double-entry ledger with the income statement, balance sheet, cash flow, trial balance and your VAT or turnover tax position." },
  { id: "payroll", name: "Payroll and statutories", status: "available", summary: "Monthly payroll with PAYE, NSSF, SHIF and the housing levy at the rates in force, payslips and the filing schedules." },
  { id: "mpesa", name: "M-Pesa", status: "available", summary: "A payment prompt on the customer’s phone, or a Till or Paybill payment recorded by its code, on your own M-Pesa account." },
  { id: "mentorship", name: "Mentorship", status: "available", summary: "Mentors and coaches follow goals and figures computed from your books, only with your consent, with every read logged for you." },
  { id: "donor", name: "Donor programmes", status: "available", summary: "Donor-funded MSME programmes see summaries for businesses under their project, with owners seeing the accessible information." },
  { id: "offline-pos", name: "Offline-capable point of sale", status: "coming", summary: "A till that keeps selling through a lost connection and sends the sales once it is back online." },
  { id: "storefront", name: "Online storefront", status: "coming", summary: "A shop for your customers online, selling from its own stock and posting to the same books." },
  { id: "marketplace", name: "Business-to-business marketplace", status: "coming", summary: "Orders and invoices between businesses that both run their books here." },
  { id: "advisory", name: "AI business advisory", status: "coming", summary: "Advice on your business drawn from your own figures." },
  { id: "trust-score", name: "Business Trust Score", status: "coming", summary: "A score built from your recorded trading history." },
  { id: "bi", name: "Advanced business intelligence", status: "coming", summary: "Deeper analysis across periods, locations and products." },
];

export const availableNow = (): Capability[] => CAPABILITIES.filter((c) => c.status === "available");
export const comingNext = (): Capability[] => CAPABILITIES.filter((c) => c.status === "coming");

export interface Industry {
  id: string;
  name: string;
  text: string;
}

/** How the business types we serve use what exists TODAY - no feature here is a coming one. */
export const INDUSTRIES: readonly Industry[] = [
  { id: "hardware", name: "Hardware stores", text: "Sell cement by the bag, wire by the metre and nails by the kilo, keep credit accounts for contractors, and hold stock at the counter and in the yard." },
  { id: "grocery", name: "Groceries and dukas", text: "Ring quick sales by barcode, split a bill between cash and M-Pesa, and see what needs reordering before the shelf is empty." },
  { id: "agrovet", name: "Agrovets", text: "Buy seed, feed and animal health products on purchase orders, receive the deliveries against them, and charge VAT only where the law says, by each product’s tax class." },
  { id: "services", name: "Salons and service businesses", text: "Sell services that carry no stock beside the products you retail, and pay your team through payroll." },
  { id: "multi-location", name: "Several shops or tills", text: "Each branch and till holds its own stock. Move stock between them, put each cashier on their till, and approve the stock they ask for." },
];

export interface Faq {
  question: string;
  answer: string;
}

/** Answer-first, and true today. The same text feeds the page and its FAQPage structured data. */
export const FAQS: readonly Faq[] = [
  { question: `What is ${PRODUCT_NAME}?`, answer: `${PRODUCT_NAME} is business software for Kenyan micro, small and medium businesses. It brings the till, stock, suppliers, customers, payroll and the books together, so every sale is recorded once and reaches proper double-entry accounts.` },
  { question: "Does my business need to be VAT registered?", answer: "No. A business can be VAT registered, on Turnover Tax, or exempt. VAT is charged on a sale only when the business is VAT registered, and Turnover Tax is worked out for a business on that regime." },
  { question: "Can it issue eTIMS invoices?", answer: "Yes. eTIMS invoices are signed for the sales you choose to file. An ordinary sale that needs no tax invoice is recorded without one." },
  { question: "How does M-Pesa work at the till?", answer: "The cashier can send a payment prompt to the customer’s phone, or record a Till or Paybill payment by its M-Pesa code. Your own M-Pesa details are used, so the money goes to your account." },
  { question: "Does the till work without an internet connection?", answer: "Not yet. Today the till needs a connection. An offline-capable till is one of the things coming next." },
  { question: "Is my business’s data kept separate?", answer: "Yes. Each business’s records are kept in their own separate database area, staff see only what their role allows, and a mentor or programme sees your figures only with your consent." },
  { question: "Can my accountant use it?", answer: "Yes. An accountant can be invited with their own sign-in to read the books, post journal entries, and produce the statements and the tax position." },
  { question: "Can I run more than one shop?", answer: "Yes. Each shop, store room or till is a location holding its own stock, and stock moves between them by transfer." },
  { question: "How much does it cost?", answer: `Prices are not published yet. ${PRODUCT_NAME} is opening to a first group of Kenyan businesses: apply with your business details, and every application is reviewed before an account is opened.` },
];
