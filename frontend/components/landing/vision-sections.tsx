import {
  BarChart3,
  BookOpen,
  GraduationCap,
  Handshake,
  Landmark,
  LayoutGrid,
  type LucideIcon,
  Package,
  ShieldCheck,
  ShoppingCart,
  Smartphone,
  Sparkles,
  Store,
  Truck,
  Wallet,
  WifiOff,
} from "lucide-react";
import { CAPABILITIES, FAQS, INDUSTRIES } from "@/lib/landing/content";

// THE LANDING'S FEATURES GRID, INDUSTRIES AND FAQ. Static. Every capability comes from
// lib/landing/content.ts as an icon and a name; a `coming` one carries a "Coming Soon" pill and
// NO link or button, so nothing implies it can be switched on today. The FAQ is a native
// <details> list (no script) and its text is the same as the page's FAQPage structured data.

const FEATURE_ICONS: Record<string, LucideIcon> = {
  pos: ShoppingCart,
  inventory: Package,
  procurement: Truck,
  accounting: BookOpen,
  payroll: Wallet,
  mpesa: Smartphone,
  mentorship: GraduationCap,
  donor: Landmark,
  "offline-pos": WifiOff,
  storefront: Store,
  marketplace: Handshake,
  advisory: Sparkles,
  "trust-score": ShieldCheck,
  bi: BarChart3,
};

export function Vision() {
  return (
    <section id="capabilities" aria-labelledby="capabilities-title" className="scroll-mt-20 border-t bg-card">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
        <h2 id="capabilities-title" className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
          Features
        </h2>
        <ul aria-label="Features" className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
          {CAPABILITIES.map((item) => {
            const Icon = FEATURE_ICONS[item.id] ?? LayoutGrid;
            const coming = item.status === "coming";
            return (
              <li
                key={item.id}
                data-status={item.status}
                className="flex flex-col gap-3 rounded-xl border bg-background p-4 sm:p-5"
              >
                <span className="inline-flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon aria-hidden="true" className="size-5" strokeWidth={1.8} />
                </span>
                <p className="font-semibold leading-snug">{item.name}</p>
                {coming ? (
                  <span className="w-fit rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                    Coming Soon
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

export function Industries() {
  return (
    <section id="industries" aria-labelledby="industries-title" className="scroll-mt-20">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
        <div className="max-w-2xl">
          <h2 id="industries-title" className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
            Made for the way your trade works
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-muted-foreground">How different businesses use what is available today.</p>
        </div>
        <ul className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {INDUSTRIES.map((industry) => (
            <li key={industry.id} className="rounded-2xl border bg-card p-6">
              <h3 className="font-display text-lg font-semibold">{industry.name}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{industry.text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function Faq() {
  return (
    <section id="faq" aria-labelledby="faq-title" className="scroll-mt-20 border-t bg-card">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
        <h2 id="faq-title" className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
          Frequently Asked Questions (FAQ)
        </h2>
        <div className="mt-10 grid items-start gap-3 lg:grid-cols-2 lg:gap-4">
          {FAQS.map((faq) => (
            <details key={faq.question} className="group rounded-xl border bg-background px-5 py-1">
              <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 py-3 font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                <h3 className="text-base">{faq.question}</h3>
                <span aria-hidden="true" className="text-xl leading-none text-muted-foreground group-open:rotate-45 motion-safe:transition-transform">
                  +
                </span>
              </summary>
              <p className="pb-4 leading-relaxed text-muted-foreground">{faq.answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
