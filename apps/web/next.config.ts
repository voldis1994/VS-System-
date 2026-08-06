import type { NextConfig } from "next";

const apiUpstream = process.env.VS_API_UPSTREAM || "http://127.0.0.1:4000";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@nexus/domain"],
  /**
   * Browser always talks to the same host as the UI (LAN IP or Cloudflare Tunnel).
   * Next proxies /api → local Nest API so clients never need port 4000 open publicly.
   */
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${apiUpstream}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
