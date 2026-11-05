import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Parallel dev servers (end-to-end runs) each need their own build directory.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Build-time switch for the test-only routes (src/shared/test-route-gate.ts). Only `E2E_BUILD=1 next build` sets "1".
  env: { E2E_BUILD: process.env.E2E_BUILD === "1" ? "1" : "0" },
  cacheComponents: true,
  partialPrefetching: true,
  // Old URLs keep working. Every redirect is temporary (307): a browser keeps a 308 forever. Route handlers answer the
  // links that need a lookup or must drop query values: `/crm/sequences/:id` (the owning campaign), `/crm/records`
  // (only `q` carries over) and `/crm/records/:id` (the person's conversation).
  async redirects() {
    return [{ source: "/settings/knowledge", destination: "/brain", permanent: false }];
  },
  async headers() {
    return [
      { source: "/:path*", headers: [{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" }] },
      // The reset token travels in the query string. No Referer header may carry it out of the page.
      { source: "/reset-password", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "no-store" }] },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
