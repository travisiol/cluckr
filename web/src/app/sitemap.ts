import type { MetadataRoute } from "next";
import { site } from "@/lib/site";

// Static export: the sitemap is written once at build time.
export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: site.url, changeFrequency: "weekly", priority: 1 }];
}
