import { PRODUCT_NAME } from "@/lib/brand";
import { formatKES } from "@/lib/money";
import { BrowserFrame } from "./device-frame";
import { HERO_SALE, Kes } from "./figures";
import { CheckGlyph, QrMark } from "./glyphs";

// THE HERO GLIMPSE - the one bold element on the page: the till, mid-day, showing a real Kenyan
// sale. It is a faithful, on-brand HTML mock, built as ONE self-contained component so it can be
// swapped for real screenshots of the app (after the localhost walkthrough) without touching the
// page around it: replace this component's body with a framed <Image>, keep its name and the
// frame's description.

const sale = HERO_SALE;
const [cash, mpesa] = sale.tenders;

const DESCRIPTION =
  `The ${PRODUCT_NAME} till: a sale of ${formatKES(sale.total, { currency: true })} for cement, wire nails and paint, ` +
  `paid ${formatKES(cash.amount, { currency: true })} in cash and ${formatKES(mpesa.amount, { currency: true })} by M-Pesa, ` +
  `with an eTIMS-signed receipt. Today's sales so far: ${formatKES(sale.todaysSales, { currency: true })}.`;

export function HeroGlimpse() {
  return (
    <BrowserFrame label={DESCRIPTION}>
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Main counter</span>
        <span>Shift open since 7:58</span>
      </div>

      <div className="grid gap-0 sm:grid-cols-[1.35fr_1fr]">
        <div className="space-y-3 p-4">
          <p className="text-xs text-muted-foreground">Sale SALE-20261111-000024</p>
          <ul className="space-y-2 text-sm">
            {sale.lines.map((line) => (
              <li key={line.name} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{line.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {line.quantity} at <Kes cents={line.unitPrice} currency={false} />
                  </span>
                </span>
                <Kes cents={line.lineNet} currency={false} className="shrink-0" />
              </li>
            ))}
          </ul>

          <dl className="space-y-1 border-t pt-3 text-sm">
            <div className="flex justify-between gap-3 text-muted-foreground">
              <dt>Subtotal</dt>
              <dd><Kes cents={sale.subtotal} currency={false} /></dd>
            </div>
            <div className="flex justify-between gap-3 text-muted-foreground">
              <dt>VAT 16%</dt>
              <dd><Kes cents={sale.vat} currency={false} /></dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 pt-1">
              <dt className="font-display font-semibold">Total</dt>
              <dd className="text-lg font-semibold"><Kes cents={sale.total} /></dd>
            </div>
          </dl>

          <div className="space-y-2 rounded-lg bg-secondary p-3 text-sm">
            <p className="text-xs font-medium text-muted-foreground">Paid with</p>
            <p className="flex justify-between gap-3">
              <span>Cash</span>
              <Kes cents={cash.amount} currency={false} />
            </p>
            <p className="flex items-center justify-between gap-3">
              <span className="flex flex-wrap items-center gap-x-2">
                M-Pesa
                <span className="inline-flex items-center gap-1 text-xs font-medium text-success-text">
                  <CheckGlyph className="size-3.5" />
                  Confirmed
                </span>
              </span>
              <Kes cents={mpesa.amount} currency={false} />
            </p>
            <p className="text-xs text-muted-foreground">M-Pesa code TKB4X7P2QM</p>
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t p-4 sm:border-l sm:border-t-0">
          <div className="rounded-lg bg-angaza-navy p-3.5 text-angaza-white">
            <p className="text-xs text-angaza-white/75">Today&rsquo;s sales</p>
            <p className="mt-1 text-xl font-semibold text-angaza-gold">
              <Kes cents={sale.todaysSales} />
            </p>
            <p className="mt-0.5 text-xs text-angaza-white/75">{sale.todaysCount} sales</p>
          </div>

          <div className="flex-1 rounded-lg border border-dashed border-input/60 bg-background p-3.5 text-xs">
            <p className="flex items-center justify-between gap-2">
              <span className="font-display text-sm font-semibold">eTIMS invoice</span>
              <span className="inline-flex items-center gap-1 font-medium text-success-text">
                <CheckGlyph className="size-3.5" />
                Signed
              </span>
            </p>
            <div className="mt-2.5 flex items-start justify-between gap-3">
              <div className="space-y-1 text-muted-foreground">
                <p>Invoice 1042</p>
                <p>VAT B 16%</p>
                <p className="text-foreground">
                  <Kes cents={sale.vat} />
                </p>
              </div>
              <QrMark className="shrink-0 text-angaza-navy" />
            </div>
          </div>
        </div>
      </div>
    </BrowserFrame>
  );
}
