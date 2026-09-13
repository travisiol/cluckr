import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The site is fully client-rendered at runtime (wallet, chain, house); a
  // static export deploys anywhere.
  reactStrictMode: true,
};

export default nextConfig;
