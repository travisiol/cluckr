import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The site is fully client-rendered at runtime (wallet, chain, house):
  // a static export deploys anywhere, and lets Vercel build it from the
  // repository root through vercel.json (`web/out`).
  output: "export",
  images: { unoptimized: true },
  reactStrictMode: true,
};

export default nextConfig;
