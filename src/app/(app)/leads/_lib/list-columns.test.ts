import { describe, expect, it } from "vitest";
import { COLUMN_LABELS, columnsCookie, columnsCookieName, DEFAULT_COLUMNS, parseColumns, serializeColumns, toggleColumn } from "./list-columns";

describe("column labels", () => {
  it("labels the contact-point column Reach and keeps its stored id", () => {
    expect(COLUMN_LABELS.contact).toBe("Reach");
    // The id stays `contact`, so a cookie saved before the rename still shows the column.
    expect(parseColumns("contact.email")).toEqual(["contact", "email"]);
    expect(Object.values(COLUMN_LABELS)).not.toContain("Contact");
  });
});

describe("list column set", () => {
  it("shows every column when nothing is saved", () => {
    expect(parseColumns(undefined)).toEqual([...DEFAULT_COLUMNS]);
    expect(parseColumns(null)).toEqual([...DEFAULT_COLUMNS]);
  });

  it("round-trips a chosen set in display order", () => {
    const saved = serializeColumns(["added", "campaign", "email"]);
    expect(saved).toBe("campaign.email.added");
    expect(parseColumns(saved)).toEqual(["campaign", "email", "added"]);
  });

  it("keeps the empty set, which is Name alone", () => {
    expect(serializeColumns([])).toBe("-");
    expect(parseColumns("-")).toEqual([]);
  });

  it("falls back to every column for a value that names none", () => {
    expect(parseColumns("")).toEqual([...DEFAULT_COLUMNS]);
    expect(parseColumns("bogus.other")).toEqual([...DEFAULT_COLUMNS]);
  });

  it("drops unknown keys and keeps the known ones", () => {
    expect(parseColumns("title.bogus.campaign")).toEqual(["campaign", "title"]);
  });

  it("reads the old channels id as contact, so a saved cookie keeps its column", () => {
    expect(parseColumns("channels.campaign.email")).toEqual(["contact", "campaign", "email"]);
    expect(parseColumns("channels")).toEqual(["contact"]);
    // Both ids in one value count once.
    expect(parseColumns("channels.contact.title")).toEqual(["contact", "title"]);
    // A saved set without the old column stays without it.
    expect(parseColumns("campaign")).toEqual(["campaign"]);
  });

  it("writes the new id", () => {
    expect(serializeColumns(parseColumns("channels.added"))).toBe("contact.added");
  });

  it("toggles a column without reordering", () => {
    expect(toggleColumn(["campaign", "email"], "title", true)).toEqual(["campaign", "email", "title"]);
    expect(toggleColumn(["campaign", "email"], "campaign", false)).toEqual(["email"]);
  });

  it("names the cookie per user and sets a year-long path cookie", () => {
    expect(columnsCookieName("0b9c8a3e-1d2f")).not.toBe(columnsCookieName("ffffffff-0000"));
    expect(columnsCookie("u1", ["email"])).toMatch(/^leads-columns-u1=email; path=\/; max-age=31536000; samesite=lax$/);
  });

  it("strips characters that cannot sit in a cookie name", () => {
    expect(columnsCookieName("a b;c=d")).toBe("leads-columns-abcd");
  });
});
