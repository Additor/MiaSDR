import { describe, expect, it } from "vitest";
import { isOwnerOrAdmin, parseRoles } from "./roles";

describe("roles", () => {
  it("parses comma-separated roles and drops unknown ones", () => {
    expect(parseRoles("member, admin,bogus")).toEqual(["member", "admin"]);
    expect(parseRoles(null)).toEqual([]);
  });
  it("detects owner or admin among several roles", () => {
    expect(isOwnerOrAdmin("member,owner")).toBe(true);
    expect(isOwnerOrAdmin("member")).toBe(false);
    expect(isOwnerOrAdmin("administrator")).toBe(false);
  });
});
