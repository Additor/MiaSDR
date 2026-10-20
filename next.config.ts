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
    return [
      // The CRM Sequences screen moved into each campaign (the After a reply setting).
      { source: "/crm/sequences", destination: "/campaigns", permanent: false },
      { source: "/crm/sequences/:id/:path+", destination: "/campaigns", permanent: false },
      // Lead and CRM split ("Leads and CRM" in docs/decisions.md). The query string passes through.
      { source: "/crm", destination: "/crm/pipeline", permanent: false },
      { source: "/crm/actions", destination: "/actions", permanent: false },
      { source: "/crm/identity-exceptions", destination: "/inbox/unmatched", permanent: false },
      // `/crm/settings` was a 308 to `/settings/crm`, which browsers keep; that hop lands here as well.
      { source: "/crm/settings", destination: "/settings/replies", permanent: false },
      { source: "/settings/crm", destination: "/settings/replies", permanent: false },
      { source: "/leads", has: [{ type: "query", key: "tab", value: "companies" }], destination: "/crm/companies", permanent: false },
      // "Needs action" was a view of the Inbox until what waits on a person moved to Actions ("Actions work queue" in docs/decisions.md).
      { source: "/inbox", has: [{ type: "query", key: "view", value: "action" }], destination: "/actions", permanent: false },
    ];
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
