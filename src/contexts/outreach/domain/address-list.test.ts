import { describe, expect, it } from "vitest";
import { parseAddressList } from "./address-list";

const emails = (v: string) => parseAddressList(v).map((a) => a.email);

describe("parseAddressList", () => {
  it("keeps display names and lowercases", () => {
    expect(parseAddressList('Sam Lee <Sam@Acme.COM>, other@acme.com')).toEqual([
      { email: "sam@acme.com", name: "Sam Lee" },
      { email: "other@acme.com", name: null },
    ]);
  });
  it("does not split on commas inside quoted names", () => {
    expect(parseAddressList('"Lee, Kim" <kim@x.com>, b@x.com')).toEqual([
      { email: "kim@x.com", name: "Lee, Kim" },
      { email: "b@x.com", name: null },
    ]);
  });
  it("handles escaped quotes and angle brackets inside quotes", () => {
    expect(emails('"A \\"<b>\\", C" <a@x.com>')).toEqual(["a@x.com"]);
  });
  it("flattens groups, including empty ones", () => {
    expect(emails("Team: a@x.com, B <b@x.com>; c@x.com")).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
    expect(emails("undisclosed-recipients:;")).toEqual([]);
  });
  it("ignores comments", () => {
    expect(emails("a@x.com (Al, the boss), b@x.com")).toEqual(["a@x.com", "b@x.com"]);
  });
  it("dedupes case-insensitively and drops invalid entries", () => {
    expect(emails("A@x.com, a@X.com, not-an-address, <>, b@x")).toEqual(["a@x.com"]);
  });
  it("returns nothing for empty input", () => {
    expect(parseAddressList(null)).toEqual([]);
    expect(parseAddressList("  ")).toEqual([]);
  });
  it("drops a display name equal to the address", () => {
    expect(parseAddressList('"a@x.com" <a@x.com>')).toEqual([{ email: "a@x.com", name: null }]);
  });
});
