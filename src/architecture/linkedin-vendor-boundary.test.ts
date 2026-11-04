import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = "src/contexts/outreach/linkedin";
const LAYERS = ["application", "domain"];

function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesIn(path) : [path];
  });
}

/** What a vendor names, sends or expects lives in `infrastructure/vendors/<vendor>`, behind `LinkedInGateway` and `LinkedInVendor`. */
describe("LinkedIn vendor boundary", () => {
  it("keeps Unipile out of the LinkedIn application and domain layers", () => {
    const leaks = LAYERS.flatMap((layer) => filesIn(join(ROOT, layer))).filter((file) => /unipile/i.test(readFileSync(file, "utf8")));
    expect(leaks).toEqual([]);
  });
});
