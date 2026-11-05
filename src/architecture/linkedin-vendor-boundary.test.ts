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
  it("keeps vendors out of the LinkedIn application and domain layers", () => {
    const leaks = LAYERS.flatMap((layer) => filesIn(join(ROOT, layer))).filter((file) => /unipile|\bedges\b|\bgtm/i.test(readFileSync(file, "utf8")));
    expect(leaks).toEqual([]);
  });

  it("keeps vendors out of the LinkedIn stores", () => {
    const stores = readdirSync(join(ROOT, "infrastructure")).filter((file) => /^drizzle-.*\.ts$|^linkedin-account-state\.ts$/.test(file));
    const leaks = stores.filter((file) => /unipile|\bedges\b|\bgtm/i.test(readFileSync(join(ROOT, "infrastructure", file), "utf8")));
    expect(leaks).toEqual([]);
  });

  it("keeps one vendor's adapter from importing another's", () => {
    const vendors = readdirSync(join(ROOT, "infrastructure/vendors"));
    const crossing = vendors.flatMap((vendor) =>
      filesIn(join(ROOT, "infrastructure/vendors", vendor)).filter((file) => vendors.some((other) => other !== vendor && new RegExp(`/${other}/`).test(readFileSync(file, "utf8").match(/from "[^"]+"/g)?.join("\n") ?? ""))),
    );
    expect(crossing).toEqual([]);
  });
});
