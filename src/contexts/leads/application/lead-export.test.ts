import { describe, expect, it } from "vitest";
import type { Actor } from "@/shared/errors";
import { exportLeadsCsv } from "./lead-management";
import type { ExportRow, LeadDeps, LeadFilter } from "./lead-ports";

const actor: Actor = { userId: "u", organizationId: "o", role: "member" };

const row = (lifecycle: string, email: string): ExportRow => ({
  firstName: null, lastName: null, fullName: null, email, phone: null, linkedinSlug: null, linkedinUrl: null, title: null,
  companyName: null, companyDomain: null, doNotContact: false, lifecycle, source: "manual", createdAt: new Date("2026-10-14T01:02:03Z"), custom: {}, raw: null,
});

describe("exportLeadsCsv", () => {
  it("writes a Lifecycle column between Created and Source data, with the stored value", async () => {
    const seen: LeadFilter[] = [];
    const deps = {
      leads: {
        customColumns: async () => [{ key: "x", name: "Size" }],
        exportBatches: async function* (_org: string, filter: LeadFilter) {
          seen.push(filter);
          yield [row("lead", "a@x.test"), row("contact", "b@x.test")];
        },
      },
    } as unknown as LeadDeps;
    let text = "";
    for await (const chunk of exportLeadsCsv(deps, actor, { lifecycle: "all" })) text += chunk;
    const [header, ...lines] = text.slice(1).trimEnd().split("\r\n");
    const columns = header.split(",");
    expect(columns.slice(columns.indexOf("Created"), columns.indexOf("Created") + 3)).toEqual(["Created", "Lifecycle", "Source data"]);
    const at = columns.indexOf("Lifecycle");
    expect(lines.map((line) => line.split(",")[at])).toEqual(["lead", "contact"]);
    expect(seen).toEqual([{ lifecycle: "all" }]);
  });

  it("exports a ticked selection by its ids alone, whatever the lifecycle and the other filters say", async () => {
    const seen: LeadFilter[] = [];
    const deps = {
      leads: {
        customColumns: async () => [],
        exportBatches: async function* (_org: string, filter: LeadFilter) {
          seen.push(filter);
        },
      },
    } as unknown as LeadDeps;
    for (const filter of [{ ids: ["p1", "p2"] }, { ids: ["p1", "p2"], lifecycle: "contact" as const, query: "zed", hasEmail: true }]) {
      for await (const chunk of exportLeadsCsv(deps, actor, filter)) void chunk;
    }
    expect(seen).toEqual([
      { ids: ["p1", "p2"], lifecycle: "all" },
      { ids: ["p1", "p2"], lifecycle: "all" },
    ]);
  });
});
