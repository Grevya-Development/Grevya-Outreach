import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    // Reuse a page you visited in the last 30s when you switch back to it (instant tab
    // switching); any save calls refresh(), so you never see stale data after an action.
    staleTimes: { dynamic: 30, static: 300 },
  },
  // The E-mail Verifier now lives under Leads → Find & verify.
  async redirects() {
    return [{ source: "/verifier", destination: "/leads/find", permanent: false }];
  },
  turbopack: {
    root: __dirname,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
