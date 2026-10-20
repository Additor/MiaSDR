import { describe, expect, it } from "vitest";
import { FORMER_MEMBER, memberItems } from "./member-select";

const members = [
  { userId: "u1", name: "Ada" },
  { userId: "u2", name: "Bea" },
];

describe("memberItems", () => {
  it("renders an unknown value as Former member, never as its id", () => {
    const items = memberItems(members, "u1", "u-gone", { value: "unassigned", label: "Unassigned", at: "start" });
    expect(items).toEqual([
      { value: "unassigned", label: "Unassigned" },
      { value: "u1", label: "Ada (you)" },
      { value: "u2", label: "Bea" },
      { value: "u-gone", label: FORMER_MEMBER },
    ]);
    expect(items.some((i) => i.label === "u-gone")).toBe(false);
  });

  it("adds nothing for a member, the empty choice or no value", () => {
    const none = { value: "none", label: "No owner", at: "end" as const };
    expect(memberItems(members, "u1", "u2", none).map((i) => i.label)).toEqual(["Ada (you)", "Bea", "No owner"]);
    expect(memberItems(members, "u1", "none", none).map((i) => i.label)).toEqual(["Ada (you)", "Bea", "No owner"]);
    expect(memberItems(members, "u1", "", none).map((i) => i.label)).toEqual(["Ada (you)", "Bea", "No owner"]);
    expect(memberItems(members, "u1", null, none).map((i) => i.label)).toEqual(["Ada (you)", "Bea", "No owner"]);
  });

  it("puts Former member before the empty choice that ends the list", () => {
    expect(memberItems(members, "u1", "u-gone", { value: "none", label: "No owner", at: "end" }).map((i) => i.label)).toEqual(["Ada (you)", "Bea", FORMER_MEMBER, "No owner"]);
  });
});
