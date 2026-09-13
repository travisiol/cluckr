import type { MetadataRoute } from "next";
import { site } from "@/lib/site";

// Static export: robots.txt is written once at build time.
export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/" }, sitemap: `${site.url}/sitemap.xml` };
}
