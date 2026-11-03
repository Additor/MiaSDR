import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "./context-layers";

/**
 * One install serves one organization, and first-run setup creates it. The schema cannot hold the limit, because tests
 * insert several organizations to prove isolation, so this scan does: no other source file may insert an organization.
 */
const ROOT = path.resolve(__dirname, "../..");
const SETUP_STORE = "src/contexts/tenancy/infrastructure/drizzle-setup-store.ts";
/** A test helper, not product code. */
const TEST_SUPPORT = "src/test-support/";

describe("creating an organization", () => {
  it("happens only in the setup store", () => {
    const writers = sourceFiles(path.join(ROOT, "src"))
      .map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
      .filter((file) => !file.startsWith(TEST_SUPPORT))
      .filter((file) => /\.insert\(\s*organizations\s*\)|insert\s+into\s+organizations\b/i.test(readFileSync(path.join(ROOT, file), "utf8")));
    expect(writers).toEqual([SETUP_STORE]);
  });
});
