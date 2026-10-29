import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-next";
import { HOME } from "@/app/_lib/home";

/** `?next=` as the sign-in page reads it, decoded by URLSearchParams. */
const nextOf = (query: string) => new URLSearchParams(query).get("next");

describe("safeNext", () => {
  it("keeps a same-site path with its query", () => {
    expect(safeNext("/leads?x=1")).toBe("/leads?x=1");
    expect(safeNext(nextOf("next=%2Fleads%3Fx%3D1"))).toBe("/leads?x=1");
  });

  it("falls back to the home page for anything that can leave the site", () => {
    for (const next of [null, "", "leads", "https://x", "//x", "/\\x", "/\t/x", "/\n/x", "/\r/x", "/x\u007f", nextOf("next=/%09/x")]) {
      expect(safeNext(next), JSON.stringify(next)).toBe(HOME);
    }
  });
});
