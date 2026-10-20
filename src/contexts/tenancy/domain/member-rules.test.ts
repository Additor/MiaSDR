import { describe, expect, it } from "vitest";
import { canGrantRole, canManageMember, keepsAnOwner, isRole } from "./member-rules";

const m = (id: string, role: string) => ({ id, userId: "u" + id, role });

describe("canGrantRole", () => {
  it("lets owners grant anything and admins everything but owner", () => {
    expect(canGrantRole("owner", "owner").ok).toBe(true);
    expect(canGrantRole("admin", "admin").ok).toBe(true);
    expect(canGrantRole("admin", "owner").ok).toBe(false);
  });
  it("refuses plain members", () => {
    expect(canGrantRole("member", "member").ok).toBe(false);
  });
  it("reads comma-separated roles", () => {
    expect(canGrantRole("member,owner", "owner").ok).toBe(true);
  });
});

describe("canManageMember", () => {
  it("keeps admins away from owners", () => {
    expect(canManageMember("admin", "owner").ok).toBe(false);
    expect(canManageMember("admin", "member").ok).toBe(true);
    expect(canManageMember("owner", "owner").ok).toBe(true);
    expect(canManageMember("member", "member").ok).toBe(false);
  });
});

describe("keepsAnOwner", () => {
  it("blocks removing or demoting the last owner", () => {
    const list = [m("1", "owner"), m("2", "admin")];
    expect(keepsAnOwner(list, "1", null).ok).toBe(false);
    expect(keepsAnOwner(list, "1", "admin").ok).toBe(false);
    expect(keepsAnOwner(list, "1", "owner").ok).toBe(true);
    expect(keepsAnOwner(list, "2", null).ok).toBe(true);
  });
  it("allows it when another owner remains", () => {
    const list = [m("1", "owner"), m("2", "owner")];
    expect(keepsAnOwner(list, "1", "member").ok).toBe(true);
    expect(keepsAnOwner(list, "2", null).ok).toBe(true);
  });
});

describe("isRole", () => {
  it("accepts the three roles only", () => {
    expect(isRole("admin")).toBe(true);
    expect(isRole("root")).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });
});
