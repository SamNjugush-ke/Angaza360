import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/brand";
import { DISALLOWED_PATHS } from "@/lib/seo-routes";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: [...DISALLOWED_PATHS] }],
    sitemap: new URL("/sitemap.xml", SITE_URL).toString(),
  };
}
