/**
 * Gate for the test-only routes (`/api/dev/inbound`, `/api/webhooks/dev-fakes`).
 *
 * `next start` always runs with NODE_ENV=production, so the end-to-end suite cannot use a NODE_ENV check.
 * The switch is a build-time flag instead: `E2E_BUILD=1 next build` inlines "1" here (see `env` in
 * next.config.ts). The production Dockerfile builds without it, so the bundle holds a constant "0" and no
 * runtime variable can turn the routes on. Outside production (`next dev`) they stay available.
 * Each route still needs its own runtime variable and a fake provider.
 */
export function testHelpersBuilt(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.E2E_BUILD === "1";
}
