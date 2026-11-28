import type { Metadata } from "next";
import { LandingPage } from "@/components/landing/landing-page";
import { faqStructuredData, JsonLd, publicEntryStructuredData } from "@/components/seo/json-ld";
import { FAQS } from "@/lib/landing/content";
import { PRODUCT_DESCRIPTION, PRODUCT_NAME, PRODUCT_TAGLINE } from "@/lib/brand";
import { publicMetadata } from "@/lib/seo";

// "/" - the public landing page. Outside the (app) noindex group, and fully static: it reads no
// session and no data. A signed-in visitor never sees it - proxy.ts sends them to /workspace - and
// on the app host an anonymous "/" goes to sign in (lib/hosts.ts). Indexable, canonical on the
// apex (metadataBase), with the shared og-image, the truthful Organization + SoftwareApplication
// JSON-LD, and (M4.5 W3) a FAQPage carrying exactly the questions the page shows.
export const dynamic = "force-static";

// The browser tab reads just the product name; shared links keep the tagline.
const TITLE = `${PRODUCT_NAME} - ${PRODUCT_TAGLINE}`;
const base = publicMetadata({ title: TITLE, description: PRODUCT_DESCRIPTION, path: "/" });

export const metadata: Metadata = {
  ...base,
  title: { absolute: PRODUCT_NAME },
  openGraph: { ...base.openGraph, title: TITLE },
  twitter: { ...base.twitter, title: TITLE },
  robots: { index: true, follow: true },
};

export default function Home() {
  return (
    <>
      <JsonLd data={publicEntryStructuredData()} />
      <JsonLd data={faqStructuredData(FAQS)} />
      <LandingPage />
    </>
  );
}
