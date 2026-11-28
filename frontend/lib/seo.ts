import type { Metadata } from "next";
import { PRODUCT_DESCRIPTION, PRODUCT_NAME } from "@/lib/brand";

// The public pages' metadata, in ONE shape: a unique title and description, a canonical path on
// the apex host (metadataBase), and Open Graph + Twitter cards with the shared og-image. Next
// replaces (does not merge) a parent's openGraph, so every page gets the image from here.

export const OG_IMAGE = {
  url: "/og-image.png",
  width: 1200,
  height: 630,
  alt: `${PRODUCT_NAME} — ${PRODUCT_DESCRIPTION}`,
} as const;

export interface PublicPage {
  /** The page's own title; the root template appends " · Angaza360". */
  title: string;
  description: string;
  /** The canonical path, e.g. "/login". */
  path: string;
  /** False for a page that exists but has nothing worth indexing yet. */
  indexable?: boolean;
}

export function publicMetadata({ title, description, path, indexable = true }: PublicPage): Metadata {
  const fullTitle = `${title} · ${PRODUCT_NAME}`;
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      siteName: PRODUCT_NAME,
      locale: "en_KE",
      url: path,
      title: fullTitle,
      description,
      images: [OG_IMAGE],
    },
    twitter: { card: "summary_large_image", title: fullTitle, description, images: [OG_IMAGE.url] },
    ...(indexable ? {} : { robots: { index: false, follow: true } }),
  };
}
