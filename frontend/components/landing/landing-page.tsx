import type { CSSProperties, ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { PRODUCT_NAME } from "@/lib/brand";
import { CookieSettingsButton } from "@/components/consent/cookie-consent";
import { LEGAL_PAGES, LEGAL_VALUES } from "@/lib/legal/config";
import { cn } from "@/lib/utils";
import { BooksGlimpse, MoneyGlimpse, PayrollGlimpse, SellGlimpse, StockGlimpse } from "./feature-glimpses";
import {
  BooksGlyph,
  LedgerGlyph,
  LocationsGlyph,
  MoneyFlowGlyph,
  MpesaGlyph,
  ReceiptGlyph,
  SellGlyph,
  StockGlyph,
  TeamGlyph,
} from "./glyphs";
import { HeroGlimpse } from "./hero-glimpse";
import { Faq, Industries, Vision } from "./vision-sections";

// THE PUBLIC LANDING PAGE - the brand's first impression. Static: no session, no data, no client
// JavaScript of its own (the mobile menu is a native <details>). The Precision palette is forced on
// by the .landing scope in globals.css. Gold appears exactly twice: the hero's one metric and the
// headline's underline. IBM Plex Mono carries KES figures and nothing else.

const SIGNUP = "/signup";
const SIGN_IN = "/login";

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";
const FOCUS_ON_NAVY = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-angaza-white focus-visible:ring-offset-2 focus-visible:ring-offset-angaza-navy";

const PRIMARY_ACTION = cn(
  "inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-6 text-base font-semibold text-primary-foreground hover:bg-primary/90",
  FOCUS,
);
const TEXT_LINK = cn("inline-flex min-h-11 items-center rounded-sm font-medium text-primary underline-offset-4 hover:underline", FOCUS);
const NAV_LINK = cn("inline-flex min-h-11 items-center rounded-sm px-2 text-sm font-medium text-foreground/80 hover:text-foreground", FOCUS);

const rise = (delay: number) => ({ "--rise-delay": `${delay}ms` }) as CSSProperties;

// The header links to the page's main sections; the footer's Product column adds Industries.
const SECTIONS = [
  { href: "#features", label: "Features" },
  { href: "#faq", label: "FAQ" },
];
const FOOTER_SECTIONS = [
  { href: "#features", label: "Features" },
  { href: "#industries", label: "Industries" },
  { href: "#faq", label: "FAQ" },
];

/** The public site's header - the landing and the legal pages share it. */
export function SiteHeader({ sectionsHref = "" }: { sectionsHref?: string }) {
  const sections = SECTIONS.map((s) => ({ ...s, href: `${sectionsHref}${s.href}` }));
  return (
    <header className="sticky top-0 z-40 print:hidden border-b border-border/80 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <Link href="/" className={cn("inline-flex min-h-11 items-center rounded-sm", FOCUS)}>
          <Image src="/brand/angaza360-logo.svg" alt={PRODUCT_NAME} width={2661} height={620} priority unoptimized className="h-7 w-auto sm:h-8" />
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-4 md:flex">
          {sections.map((s) => (
            <a key={s.href} href={s.href} className={NAV_LINK}>
              {s.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <Link href={SIGN_IN} className={cn(NAV_LINK, "hidden sm:inline-flex")}>
            Sign in
          </Link>
          <Link href={SIGNUP} className={cn(PRIMARY_ACTION, "px-4 text-sm")}>
            Request access
          </Link>
          <details className="group relative md:hidden">
            <summary
              className={cn(
                "flex size-11 cursor-pointer list-none items-center justify-center rounded-md text-foreground hover:bg-secondary [&::-webkit-details-marker]:hidden",
                FOCUS,
              )}
            >
              <span className="sr-only">Menu</span>
              <svg viewBox="0 0 24 24" width={22} height={22} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
                <path d="M4 7h16M4 12h16M4 17h10" className="group-open:hidden" />
                <path d="M6 6l12 12M18 6L6 18" className="hidden group-open:block" />
              </svg>
            </summary>
            <nav aria-label="Menu" className="absolute right-0 top-full mt-2 w-56 rounded-lg border bg-card p-2 shadow-lg">
              {sections.map((s) => (
                <a key={s.href} href={s.href} className={cn(NAV_LINK, "flex w-full px-3")}>
                  {s.label}
                </a>
              ))}
              <Link href={SIGN_IN} className={cn(NAV_LINK, "flex w-full border-t px-3")}>
                Sign in
              </Link>
            </nav>
          </details>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section aria-labelledby="hero-title" className="mx-auto grid max-w-6xl gap-10 px-4 pb-16 pt-10 sm:px-6 sm:pt-14 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.15fr)] lg:items-center lg:gap-14 lg:pb-24 lg:pt-20">
      <div>
        <h1
          id="hero-title"
          className="landing-rise font-display text-[2.1rem] font-bold leading-[1.1] tracking-tight text-foreground sm:text-5xl lg:text-[3.35rem]"
        >
          Every sale, in proper books and{" "}
          <span className="underline decoration-angaza-gold decoration-[0.14em] underline-offset-[0.16em]">ready for compliance</span>.
        </h1>
        <p className="landing-rise mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground" style={rise(120)}>
          {PRODUCT_NAME} is point of sale, stock, accounting and payroll in one place for Kenyan businesses. Take cash,
          M-Pesa or credit at the counter, and every sale lands in real double-entry books, with eTIMS invoices
          whenever customers need them.
        </p>
        <div className="landing-rise mt-8 flex flex-wrap items-center gap-x-6 gap-y-3" style={rise(220)}>
          <Link href={SIGNUP} className={PRIMARY_ACTION}>
            Request access
          </Link>
          <a href="#features" className={TEXT_LINK}>
            See what it does
          </a>
        </div>
        <p className="landing-rise mt-6 text-sm text-muted-foreground" style={rise(300)}>
          Built in Kenya for micro, small and medium businesses.
        </p>
      </div>
      <div className="landing-rise min-w-0" style={rise(260)}>
        <HeroGlimpse />
      </div>
    </section>
  );
}

const TRUST = [
  { glyph: MpesaGlyph, title: "M-Pesa", text: "STK prompts at the till, and Till or Paybill payments recorded by their code." },
  { glyph: ReceiptGlyph, title: "eTIMS invoices", text: "Signed eTIMS invoices, only for the sales that need one." },
  { glyph: LedgerGlyph, title: "Real double-entry books", text: "Every sale, bill and payslip posts a balanced journal entry." },
  { glyph: LocationsGlyph, title: "Multi-till and locations", text: "Each till and store holds its own stock, moved between them by transfer." },
];

function TrustStrip() {
  return (
    <section aria-labelledby="trust-title" className="border-y bg-card">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <h2 id="trust-title" className="font-display text-xl font-semibold sm:text-2xl">
          Built for how Kenya does business
        </h2>
        <ul className="mt-8 grid gap-x-8 gap-y-8 sm:grid-cols-2 lg:grid-cols-4 lg:divide-x lg:divide-border">
          {TRUST.map(({ glyph: Glyph, title, text }, index) => (
            <li key={title} className={cn("flex gap-4 lg:flex-col lg:gap-3", index > 0 && "lg:pl-8")}>
              <Glyph className="size-8 shrink-0 text-primary" />
              <div>
                <h3 className="font-semibold">{title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{text}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

interface Feature {
  id: string;
  name: string;
  glyph: typeof SellGlyph;
  title: string;
  body: string;
  points: string[];
  glimpse: ReactNode;
}

const FEATURES: Feature[] = [
  {
    id: "sell",
    name: "Sell",
    glyph: SellGlyph,
    title: "Ring every sale - cash, M-Pesa or credit.",
    body: "Send an M-Pesa prompt straight to the customer’s phone, split a bill between cash and M-Pesa, sell on account to customers you trust, and close the shift against the cash you count.",
    points: ["M-Pesa STK prompts", "Split payments", "Instant receipts", "Shift close"],
    glimpse: <SellGlimpse />,
  },
  {
    id: "stock",
    name: "Stock and suppliers",
    glyph: StockGlyph,
    title: "Know what you have, and when to reorder.",
    body: "Stock is held by location, so each counter sells only what it holds. Raise purchase orders, receive deliveries against them, and see what needs reordering before it runs out.",
    points: ["Stock across locations", "Purchase orders", "Goods receipts"],
    glimpse: <StockGlimpse />,
  },
  {
    id: "money",
    name: "Money owed and owing",
    glyph: MoneyFlowGlyph,
    title: "See who owes you, and who you owe.",
    body: "Customer accounts show what each customer owes and for how long. Supplier bills are matched to what you received and paid when they fall due, and every balance has a statement behind it.",
    points: ["Customer accounts", "Supplier bills", "Statements", "Aging"],
    glimpse: <MoneyGlimpse />,
  },
  {
    id: "books",
    name: "The Books",
    glyph: BooksGlyph,
    title: "Proper books, without the headache.",
    body: "Every sale, purchase, expense and payslip posts a balanced double entry, so your statements and your VAT or turnover tax position are always current, and signed eTIMS invoices.",
    points: ["Double-entry ledger", "VAT or turnover tax", "eTIMS invoices", "Financial statements"],
    glimpse: <BooksGlimpse />,
  },
  {
    id: "payroll",
    name: "Team and payroll",
    glyph: TeamGlyph,
    title: "Pay your people, file the statutories.",
    body: "Keep employee records and run the month’s payroll. PAYE, NSSF, SHIF and the housing levy are worked out at the rates in force, and the payslips and statutory schedules come out ready for filing.",
    points: ["Employees", "Payroll runs", "PAYE, NSSF, SHIF and housing levy", "Payslips"],
    glimpse: <PayrollGlimpse />,
  },
];

function Features() {
  return (
    <section id="features" aria-labelledby="features-title" className="scroll-mt-20">
      <div className="mx-auto max-w-6xl px-4 pt-20 sm:px-6 lg:pt-28">
        <div className="max-w-2xl">
          <h2 id="features-title" className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
            The counter and the back office, in one place
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
            What happens at the till is what reaches the books. Nothing is typed in twice, and nothing waits for the end of the
            month to be counted.
          </p>
        </div>

        <div className="mt-14 space-y-20 pb-20 lg:mt-20 lg:space-y-28 lg:pb-28">
          {FEATURES.map((feature, index) => {
            const Glyph = feature.glyph;
            const flipped = index % 2 === 1;
            return (
              <article
                key={feature.id}
                aria-labelledby={`feature-${feature.id}`}
                className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16"
              >
                <div className={cn("min-w-0", flipped && "lg:order-2")}>
                  <p className="flex items-center gap-2.5 text-sm font-semibold text-primary">
                    <span className="inline-flex size-10 items-center justify-center rounded-lg bg-primary/10">
                      <Glyph className="size-6" />
                    </span>
                    {feature.name}
                  </p>
                  <h3 id={`feature-${feature.id}`} className="mt-4 font-display text-2xl font-bold leading-tight tracking-tight sm:text-3xl">
                    {feature.title}
                  </h3>
                  <p className="mt-4 max-w-xl leading-relaxed text-muted-foreground">{feature.body}</p>
                  <ul className="mt-6 flex flex-wrap gap-2">
                    {feature.points.map((point) => (
                      <li key={point} className="rounded-full border bg-card px-3 py-1.5 text-sm">
                        {point}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className={cn("min-w-0", flipped && "lg:order-1")}>{feature.glimpse}</div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section aria-labelledby="final-title" className="bg-angaza-navy text-angaza-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-16 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:py-20">
        <div className="max-w-2xl">
          <h2 id="final-title" className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
            Bring the counter and the books together.
          </h2>
          <p className="mt-3 text-lg text-angaza-white/80">Apply for access to set your business up.</p>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <Link
            href={SIGNUP}
            className={cn(
              "inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-6 text-base font-semibold text-primary-foreground hover:bg-primary/90",
              FOCUS_ON_NAVY,
            )}
          >
            Request access
          </Link>
          <Link href={SIGN_IN} className={cn("inline-flex min-h-11 items-center rounded-sm font-medium underline underline-offset-4", FOCUS_ON_NAVY)}>
            Sign in
          </Link>
        </div>
      </div>
    </section>
  );
}

const FOOTER_LINK = cn("inline-flex min-h-11 items-center rounded-sm text-sm text-muted-foreground hover:text-foreground sm:min-h-9", FOCUS);

/** The public site's footer - the landing and the legal pages share it. */
export function SiteFooter({ sectionsHref = "" }: { sectionsHref?: string }) {
  const sections = FOOTER_SECTIONS.map((s) => ({ ...s, href: `${sectionsHref}${s.href}` }));
  const support = LEGAL_VALUES.SUPPORT_EMAIL;
  return (
    <footer className="border-t bg-card print:hidden">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:grid-cols-2 sm:px-6 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div>
          <Image src="/brand/angaza360-logo.svg" alt={PRODUCT_NAME} width={2661} height={620} unoptimized className="h-7 w-auto" />
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-muted-foreground">
            Built in Kenya, for Kenyan micro, small and medium businesses.
          </p>
        </div>
        <nav aria-label="Product">
          <h2 className="text-sm font-semibold">Product</h2>
          <ul className="mt-3">
            {[...sections, { href: SIGNUP, label: "Request access" }].map((s) => (
              <li key={s.href}>
                {s.href.includes("#") ? (
                  <a href={s.href} className={FOOTER_LINK}>
                    {s.label}
                  </a>
                ) : (
                  <Link href={s.href} className={FOOTER_LINK}>
                    {s.label}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </nav>
        <div>
          <h2 className="text-sm font-semibold">Contact</h2>
          {support ? (
            <a href={`mailto:${support}`} className={cn(TEXT_LINK, "mt-1 text-sm")}>
              {support}
            </a>
          ) : null}
          <Link href="/contact" className={cn(FOOTER_LINK, "flex")}>
            How to reach us
          </Link>
        </div>
        <nav aria-label="Legal">
          <h2 className="text-sm font-semibold">Legal</h2>
          <ul className="mt-3">
            {LEGAL_PAGES.filter((page) => page.href !== "/contact").map((page) => (
              <li key={page.href}>
                <Link href={page.href} className={FOOTER_LINK}>
                  {page.label}
                </Link>
              </li>
            ))}
            <li>
              <CookieSettingsButton className={FOOTER_LINK} />
            </li>
          </ul>
        </nav>
      </div>
      <div className="border-t">
        <p className="mx-auto max-w-6xl px-4 py-5 text-xs text-muted-foreground sm:px-6">
          © {COPYRIGHT_YEAR} {PRODUCT_NAME}. All rights reserved.
        </p>
      </div>
    </footer>
  );
}

/** The year the page was built; the landing is statically generated and rebuilt on every release. */
const COPYRIGHT_YEAR = new Date().getFullYear();

export function LandingPage() {
  return (
    <div className="landing min-h-screen bg-background text-foreground">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-card px-4 py-3 font-medium text-primary focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      <SiteHeader />
      <main id="main">
        <Hero />
        <TrustStrip />
        <Features />
        <Vision />
        <Industries />
        <Faq />
        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}
