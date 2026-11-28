import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/brand";
import { INDEXABLE_PATHS } from "@/lib/seo-routes";

// Only public, indexable routes — never an authenticated or noindex one.
export default function sitemap(): MetadataRoute.Sitemap {
  return INDEXABLE_PATHS.map((path) => ({ url: new URL(path, SITE_URL).toString(), changeFrequency: "monthly", priority: 1 }));
}
