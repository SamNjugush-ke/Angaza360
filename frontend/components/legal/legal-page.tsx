import type { ReactNode } from "react";
import { SiteFooter, SiteHeader } from "@/components/landing/landing-page";
import { JsonLd, breadcrumbStructuredData } from "@/components/seo/json-ld";

// The public legal pages' layout: the landing's own header and footer (the Precision palette via
// the .landing scope), one h1, and a readable article that prints cleanly (site chrome and the
// cookie banner are print:hidden). The copy is final and reviewed (lib/legal/content.ts).

const PROSE =
  "space-y-4 text-base leading-relaxed text-foreground [&_h2]:mt-8 [&_h2]:font-display [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h3]:mt-6 [&_h3]:text-lg [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6 [&_strong]:font-semibold [&_a]:text-primary [&_a]:underline-offset-4 hover:[&_a]:underline [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-sm";

export function LegalPage({ title, path, children }: { title: string; path: string; children: ReactNode }) {
  return (
    <div className="landing min-h-screen bg-background text-foreground">
      <JsonLd data={breadcrumbStructuredData([{ name: title, path }])} />
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-card px-4 py-3 font-medium text-primary focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      <SiteHeader sectionsHref="/" />
      <main id="main" className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16 print:max-w-none print:py-0">
        <article>
          <h1 className="font-display text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">{title}</h1>
          <div className={`mt-8 ${PROSE}`}>{children}</div>
        </article>
      </main>
      <SiteFooter sectionsHref="/" />
    </div>
  );
}
