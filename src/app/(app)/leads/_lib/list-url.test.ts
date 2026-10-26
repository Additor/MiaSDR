import { describe, expect, it } from "vitest";
import { leadsHref } from "./list-url";

describe("leadsHref", () => {
  it("carries the filters, keeps the sort and drops the page", () => {
    const href = leadsHref({ filter: { replied: true, lastContactFrom: "2026-09-01" }, sort: { key: "name", dir: "asc" } });
    expect(href).toBe("/leads?replied=yes&lastFrom=2026-09-01&sort=name&dir=asc");
  });

  it("is the bare list for the default state", () => {
    expect(leadsHref({ filter: {}, sort: { key: "created", dir: "desc" } })).toBe("/leads");
  });
});
