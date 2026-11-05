import { describe, expect, it } from "vitest";
import { parsePageParam } from "./page-param";

describe("parsePageParam", () => {
  it("reads a whole page number and cuts a fraction", () => {
    expect(parsePageParam("3")).toBe(3);
    expect(parsePageParam("3.9")).toBe(3);
  });
  it("answers 1 for what is no page", () => {
    for (const raw of [undefined, "", "abc", "0", "-2", "Infinity", "-Infinity", "1e30", "NaN"]) expect(parsePageParam(raw)).toBe(1);
  });
  it("caps a large page, so the offset stays one Postgres can read", () => {
    expect(parsePageParam("999999999999")).toBe(1_000_000);
  });
});
