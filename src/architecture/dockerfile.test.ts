import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The production image must not turn on the test-only routes. e2e/09 proves the routes answer 404 on a build made with
 * the Dockerfile's flags; this check keeps those flags free of the e2e switches.
 */
describe("Dockerfile", () => {
  const dockerfile = readFileSync(path.join(process.cwd(), "Dockerfile"), "utf8");

  it("does not enable the test build flag", () => {
    expect(dockerfile).not.toMatch(/E2E_/);
  });

  it("builds with pnpm build and runs with NODE_ENV=production", () => {
    expect(dockerfile).toMatch(/RUN pnpm build\b/);
    expect(dockerfile).toMatch(/ENV[^\n]*NODE_ENV=production/);
  });
});
