import { describe, expect, it } from "vitest";
import { isUuid } from "./uuid";

describe("isUuid", () => {
  it("takes a canonical UUID in either case and nothing else", () => {
    expect(isUuid("4f6c1f6e-7a0b-4c55-9d7e-2b1c3a4d5e6f")).toBe(true);
    expect(isUuid("4F6C1F6E-7A0B-4C55-9D7E-2B1C3A4D5E6F")).toBe(true);
    for (const value of ["jo@linkedin", "4f6c1f6e7a0b4c559d7e2b1c3a4d5e6f", " 4f6c1f6e-7a0b-4c55-9d7e-2b1c3a4d5e6f", null, 7]) expect(isUuid(value)).toBe(false);
  });
});
