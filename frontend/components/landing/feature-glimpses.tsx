import type { ReactNode } from "react";
import { formatKES } from "@/lib/money";
import { BrowserFrame, PhoneFrame } from "./device-frame";
import { AGING, HERO_SALE, Kes, PAYSLIP, STATEMENT, sum } from "./figures";
import { CheckGlyph } from "./glyphs";

// One product glimpse per feature row, deliberately varied: a phone (M-Pesa at the counter), two
// browser windows (stock, the books) and two paper documents (a statement, a payslip). Each is an
// illustration with a written description; like the hero, each can be swapped for a screenshot.

const kes = (cents: bigint) => formatKES(cents, { currency: true });
const mpesa = HERO_SALE.tenders[1];

function Paid({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-success-text">
      <CheckGlyph className="size-3.5" />
      {children}
    </span>
  );
}

export function SellGlimpse() {
  const expected = 1_245_000n;
  return (
    <PhoneFrame
      label={`An M-Pesa prompt for ${kes(mpesa.amount)} confirmed by the customer, and a shift closed with ${kes(expected)} expected, the same counted and nothing over or short.`}
    >
      <div className="space-y-4 p-4 text-sm">
        <div>
          <p className="text-xs text-muted-foreground">M-Pesa payment</p>
          <p className="mt-1 text-2xl font-semibold">
            <Kes cents={mpesa.amount} />
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Prompt sent to 0712 345 678</p>
        </div>
        <div className="flex items-center justify-between rounded-lg bg-secondary px-3 py-2.5">
          <Paid>Customer confirmed</Paid>
          <span className="text-xs text-muted-foreground">TKB4X7P2QM</span>
        </div>
        <div className="space-y-1.5 border-t pt-3">
          <p className="font-display font-semibold">Close shift</p>
          <p className="flex justify-between text-xs">
            <span className="text-muted-foreground">Expected cash</span>
            <Kes cents={expected} currency={false} />
          </p>
          <p className="flex justify-between text-xs">
            <span className="text-muted-foreground">Counted</span>
            <Kes cents={expected} currency={false} />
          </p>
          <p className="flex items-center justify-between text-xs">
            <Paid>Balanced</Paid>
            <Kes cents={0n} currency={false} />
          </p>
        </div>
      </div>
    </PhoneFrame>
  );
}

const STOCK = [
  { product: "Cement 50 kg", main: 140, counter: 24, reorder: false },
  { product: "Wire nails 3 inch, 1 kg", main: 12, counter: 6, reorder: true },
  { product: "Gloss paint 4 L", main: 38, counter: 5, reorder: false },
];

export function StockGlimpse() {
  return (
    <BrowserFrame label="Stock held at the main store and the counter, with wire nails flagged for reordering, and a purchase order with 6 of its 10 cartons received.">
      <div className="p-4 text-sm">
        <p className="font-display font-semibold">Stock by location</p>
        <div className="mt-3 overflow-hidden rounded-lg border">
          <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 bg-secondary px-3 py-2 text-xs text-muted-foreground">
            <span>Product</span>
            <span className="w-14 text-right">Store</span>
            <span className="w-14 text-right">Counter</span>
          </div>
          {STOCK.map((row) => (
            <div key={row.product} className="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 border-t px-3 py-2">
              <span className="min-w-0">
                <span className="block truncate">{row.product}</span>
                {row.reorder ? <span className="text-xs font-medium text-warning">Reorder now</span> : null}
              </span>
              <span className="w-14 text-right tabular">{row.main}</span>
              <span className="w-14 text-right tabular">{row.counter}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 rounded-lg border p-3">
          <p className="flex justify-between gap-3 text-xs">
            <span className="font-medium">Purchase order PO-000042</span>
            <span className="text-muted-foreground">6 of 10 received</span>
          </p>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary">
            <div className="h-full w-[60%] rounded-full bg-primary" />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Goods receipt GRN-000107 posted to stock</p>
        </div>
      </div>
    </BrowserFrame>
  );
}

function AgingList({ rows }: { rows: readonly { bucket: string; amount: bigint }[] }) {
  const total = sum(rows.map((row) => row.amount));
  return (
    <ul className="mt-3 space-y-2">
      {rows.map((row) => (
        <li key={row.bucket} className="text-xs">
          <span className="flex justify-between gap-3">
            <span className="text-muted-foreground">{row.bucket}</span>
            <Kes cents={row.amount} currency={false} />
          </span>
          <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-secondary">
            <span className="block h-full rounded-full bg-primary" style={{ width: `${((row.amount * 100n) / total).toString()}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export function MoneyGlimpse() {
  const owed = sum(AGING.receivable.map((row) => row.amount));
  const owing = sum(AGING.payable.map((row) => row.amount));
  return (
    <div role="img" aria-label={`Customers owe ${kes(owed)}, sorted by how long it has been owed; the business owes suppliers ${kes(owing)}, sorted by when it is due.`}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">Customers owe you</p>
          <p className="mt-1 text-xl font-semibold">
            <Kes cents={owed} />
          </p>
          <AgingList rows={AGING.receivable} />
        </div>
        <div className="rounded-xl border bg-card p-4 sm:mt-8">
          <p className="text-xs text-muted-foreground">You owe suppliers</p>
          <p className="mt-1 text-xl font-semibold">
            <Kes cents={owing} />
          </p>
          <AgingList rows={AGING.payable} />
          <p className="mt-3 border-t pt-2 text-xs text-muted-foreground">Statement ready for Kiptoo Construction</p>
        </div>
      </div>
    </div>
  );
}

export function BooksGlimpse() {
  const s = STATEMENT;
  const rows = [
    { label: "Revenue", amount: s.revenue },
    { label: "Cost of sales", amount: -s.costOfSales },
    { label: "Gross profit", amount: s.gross, strong: true },
    { label: "Operating expenses", amount: -s.expenses },
  ];
  return (
    <BrowserFrame
      label={`An income statement for October 2026: revenue ${kes(s.revenue)}, net profit ${kes(s.net)}; the trial balance agrees at ${kes(s.trialBalance)} on both sides, and the VAT return shows ${kes(s.outputVat)} of output VAT.`}
    >
      <div className="grid gap-0 text-sm sm:grid-cols-[1.4fr_1fr]">
        <div className="p-4">
          <p className="font-display font-semibold">Income statement</p>
          <p className="text-xs text-muted-foreground">October 2026</p>
          <dl className="mt-3 space-y-1.5">
            {rows.map((row) => (
              <div key={row.label} className={row.strong ? "flex justify-between gap-3 border-t pt-1.5 font-medium" : "flex justify-between gap-3"}>
                <dt className={row.strong ? undefined : "text-muted-foreground"}>{row.label}</dt>
                <dd>
                  <Kes cents={row.amount < 0n ? -row.amount : row.amount} currency={false} className={row.amount < 0n ? "before:content-['('] after:content-[')']" : undefined} />
                </dd>
              </div>
            ))}
            <div className="flex justify-between gap-3 border-t-2 border-foreground pt-1.5 font-semibold">
              <dt>Net profit</dt>
              <dd><Kes cents={s.net} currency={false} /></dd>
            </div>
          </dl>
        </div>
        <div className="space-y-3 border-t bg-background p-4 text-xs sm:border-l sm:border-t-0">
          <div>
            <p className="font-medium">Trial balance</p>
            <p className="mt-1 flex justify-between gap-2">
              <span className="text-muted-foreground">Debits</span>
              <Kes cents={s.trialBalance} currency={false} />
            </p>
            <p className="flex justify-between gap-2">
              <span className="text-muted-foreground">Credits</span>
              <Kes cents={s.trialBalance} currency={false} />
            </p>
            <p className="mt-1">
              <Paid>Books balance</Paid>
            </p>
          </div>
          <div className="border-t pt-3">
            <p className="font-medium">VAT return</p>
            <p className="mt-1 flex justify-between gap-2">
              <span className="text-muted-foreground">Output VAT</span>
              <Kes cents={s.outputVat} currency={false} />
            </p>
            <p className="mt-1">
              <Paid>eTIMS invoices signed</Paid>
            </p>
          </div>
        </div>
      </div>
    </BrowserFrame>
  );
}

export function PayrollGlimpse() {
  const p = PAYSLIP;
  return (
    <div
      role="img"
      aria-label={`A payslip for October 2026: gross pay ${kes(p.gross)}, NSSF, SHIF, housing levy and PAYE deducted, net pay ${kes(p.net)} paid by M-Pesa.`}
      className="mx-auto w-full max-w-sm -rotate-1 rounded-sm border bg-card p-5 text-sm shadow-[0_18px_40px_-24px_rgb(var(--angaza-navy)/0.4)]"
    >
      <div className="flex items-baseline justify-between gap-3 border-b pb-2">
        <p className="font-display font-semibold">Payslip</p>
        <p className="text-xs text-muted-foreground">October 2026</p>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Wanjiku Mwangi, sales assistant</p>
      <dl className="mt-3 space-y-1.5">
        <div className="flex justify-between gap-3 font-medium">
          <dt>Gross pay</dt>
          <dd><Kes cents={p.gross} currency={false} /></dd>
        </div>
        {p.deductions.map((d) => (
          <div key={d.name} className="flex justify-between gap-3 text-muted-foreground">
            <dt>{d.name}</dt>
            <dd><Kes cents={d.amount} currency={false} /></dd>
          </div>
        ))}
        <div className="flex justify-between gap-3 border-t-2 border-foreground pt-1.5 font-semibold">
          <dt>Net pay</dt>
          <dd><Kes cents={p.net} /></dd>
        </div>
      </dl>
      <p className="mt-3">
        <Paid>Paid by M-Pesa</Paid>
      </p>
    </div>
  );
}
