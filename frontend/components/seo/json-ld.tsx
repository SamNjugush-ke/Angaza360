import { PRODUCT_DESCRIPTION, PRODUCT_NAME, SITE_URL } from "@/lib/brand";

// Structured data (schema.org JSON-LD). It states ONLY what is true of the product today: who
// makes it and what it is. There is no WebSite SearchAction (the site has no search) and no
// rating, review or offer (none exist). Add one when the thing it describes exists.

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const absolute = (path: string) => new URL(path, SITE_URL).toString();

export function publicEntryStructuredData(): { [key: string]: JsonValue } {
  const organizationId = absolute("/#organization");
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": organizationId,
        name: PRODUCT_NAME,
        url: absolute("/"),
        logo: absolute("/icons/icon-512.png"),
        areaServed: "KE",
      },
      {
        "@type": "SoftwareApplication",
        name: PRODUCT_NAME,
        description: PRODUCT_DESCRIPTION,
        url: absolute("/"),
        applicationCategory: "BusinessApplication",
        applicationSubCategory: "Business management for Kenyan micro, small and medium enterprises",
        operatingSystem: "Web",
        inLanguage: "en-KE",
        publisher: { "@id": organizationId },
      },
    ],
  };
}

/** A BreadcrumbList for a nested public page: Home, then each crumb (FP-SEO law, clause 2). */
export function breadcrumbStructuredData(crumbs: ReadonlyArray<{ name: string; path: string }>): { [key: string]: JsonValue } {
  const items = [{ name: PRODUCT_NAME, path: "/" }, ...crumbs];
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: absolute(item.path),
    })),
  };
}

/**
 * A FAQPage for the landing's questions (FP-SEO law, clause 2 — what feeds answer engines). The
 * questions and answers are the SAME text the page shows, so the structured data cannot claim more.
 */
export function faqStructuredData(faqs: ReadonlyArray<{ question: string; answer: string }>): { [key: string]: JsonValue } {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((faq) => ({ "@type": "Question", name: faq.question, acceptedAnswer: { "@type": "Answer", text: faq.answer } })),
  };
}

/** Renders a JSON-LD block. `<` is escaped so a value can never close the script element. */
export function JsonLd({ data }: { data: { [key: string]: JsonValue } }) {
  return (
    <script
      type="application/ld+json"
      // The content is our own constant data, serialised and escaped — never user input.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }}
    />
  );
}
