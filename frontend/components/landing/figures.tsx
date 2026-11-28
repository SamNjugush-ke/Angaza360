import { formatKES } from "@/lib/money";
import { cn } from "@/lib/utils";

// The landing page's figures. Every amount is held as bigint cents and summed here, so a glimpse
// can never show a total its lines do not add up to; IBM Plex Mono is used for these KES figures
// and for nothing else on the page.

export function Kes({ cents, currency = true, className }: { cents: bigint; currency?: boolean; className?: string }) {
  return <span className={cn("font-mono tabular", className)}>{formatKES(cents, { currency })}</span>;
}

export const sum = (values: readonly bigint[]): bigint => values.reduce((a, b) => a + b, 0n);

/** VAT at a whole-number percentage of a net amount, rounded half-up to the cent. */
export const vatOn = (net: bigint, percent: bigint): bigint => (net * percent * 2n + 100n) / 200n;

/** The sale in the hero: a Nakuru-style hardware counter, VAT-registered, standard-rated lines. */
export const HERO_SALE = (() => {
  const lines = [
    { name: "Cement 50 kg", quantity: 2, unitPrice: 85_000n },
    { name: "Wire nails 3 inch, 1 kg", quantity: 3, unitPrice: 18_000n },
    { name: "Gloss paint 4 L", quantity: 1, unitPrice: 96_000n },
  ].map((line) => ({ ...line, lineNet: line.unitPrice * BigInt(line.quantity) }));
  const subtotal = sum(lines.map((line) => line.lineNet));
  const vat = vatOn(subtotal, 16n);
  const total = subtotal + vat;
  const cash = 200_000n;
  const tenders = [
    { method: "Cash", amount: cash },
    { method: "M-Pesa", amount: total - cash },
  ];
  return { lines, subtotal, vat, total, tenders, todaysSales: 4_835_000n, todaysCount: 24 };
})();

/** The payslip in the payroll row - the KE-2026-02 worked example, to the cent. */
export const PAYSLIP = (() => {
  const gross = 10_000_000n;
  const deductions = [
    { name: "NSSF", amount: 600_000n },
    { name: "SHIF", amount: 275_000n },
    { name: "Housing levy", amount: 150_000n },
    { name: "PAYE", amount: 1_930_835n },
  ];
  return { gross, deductions, net: gross - sum(deductions.map((d) => d.amount)) };
})();

/** The money row: what customers owe, by age, and what is owed to suppliers, by due date. */
export const AGING = {
  receivable: [
    { bucket: "Current", amount: 3_100_000n },
    { bucket: "1 to 30 days", amount: 1_425_000n },
    { bucket: "31 to 60 days", amount: 800_000n },
  ],
  payable: [
    { bucket: "Not yet due", amount: 12_000_000n },
    { bucket: "Due this week", amount: 2_665_125n },
  ],
} as const;

/** The books row: an income statement that adds up, and the VAT it carries. */
export const STATEMENT = (() => {
  const revenue = 41_280_000n;
  const costOfSales = 26_832_000n;
  const gross = revenue - costOfSales;
  const expenses = 6_190_000n;
  return { revenue, costOfSales, gross, expenses, net: gross - expenses, outputVat: vatOn(revenue, 16n), trialBalance: 128_496_000n };
})();
