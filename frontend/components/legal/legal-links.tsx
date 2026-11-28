import Link from "next/link";
import { LEGAL_PAGES } from "@/lib/legal/config";

/** The legal pages, as a quiet line of links under the sign-in and application cards. */
export function LegalLinks() {
  return (
    <nav aria-label="Legal" className="print:hidden">
      <ul className="flex flex-wrap justify-center gap-x-4 text-sm text-muted-foreground">
        {LEGAL_PAGES.map((page) => (
          <li key={page.href}>
            <Link
              href={page.href}
              className="inline-flex min-h-11 items-center rounded-sm underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {page.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
