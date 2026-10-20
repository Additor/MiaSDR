import { describe, expect, it } from "vitest";
import { backToListHref, leadHref, listQueryOf, neighborHref, parseListContext } from "./list-context";

const UUID = "0d6f9d42-0f4a-4f43-9d2e-4a5b1f2e9c11";

describe("lead row link", () => {
  it("carries the list's query string", () => {
    expect(leadHref("abc", "q=ada&sort=name&dir=asc")).toBe("/leads/abc?list=q%3Dada%26sort%3Dname%26dir%3Dasc");
  });
  it("keeps the context for the unfiltered list and drops it when there is none", () => {
    expect(leadHref("abc", "")).toBe("/leads/abc?list=");
    expect(leadHref("abc")).toBe("/leads/abc");
    expect(leadHref("abc", null)).toBe("/leads/abc");
  });
  it("reads the query string out of a list URL", () => {
    expect(listQueryOf("/leads?q=ada&page=2")).toBe("q=ada&page=2");
    expect(listQueryOf("/leads")).toBe("");
  });
});

describe("parseListContext", () => {
  it("returns null without the param, so the controls hide", () => {
    expect(parseListContext(undefined)).toBeNull();
    expect(parseListContext(["a", "b"])).toBeNull();
    expect(parseListContext("x".repeat(2001))).toBeNull();
  });

  it("reads the filter and the sort the way the list does", () => {
    const context = parseListContext(`q=ada&campaign=${UUID}&sort=company&dir=desc&replied=yes&page=3`);
    expect(context?.filter).toEqual({ query: "ada", campaign: UUID, replied: true });
    expect(context?.sort).toEqual({ key: "company", dir: "desc" });
  });

  it("treats the empty query as the default list", () => {
    const context = parseListContext("");
    expect(context?.filter).toEqual({});
    expect(context?.sort).toEqual({ key: "created", dir: "desc" });
    expect(context?.query).toBe("");
  });

  it("drops values the list would drop", () => {
    const context = parseListContext("campaign=not-a-uuid&sort=bogus&dir=sideways&from=2024-13-45");
    expect(context?.filter).toEqual({});
    expect(context?.sort).toEqual({ key: "created", dir: "desc" });
    expect(context?.query).toBe("");
  });

  it("keeps page and size for the way back and refuses non-numeric ones", () => {
    expect(parseListContext("q=ada&page=2&size=100")?.query).toBe("q=ada&page=2&size=100");
    expect(parseListContext("page=x1&size=-3")?.query).toBe("");
  });
});

describe("neighborHref and backToListHref", () => {
  const context = parseListContext("q=ada&sort=name&dir=asc");
  it("builds the neighbor URL with the same context, or null at an end", () => {
    expect(context && neighborHref("n1", context)).toBe("/leads/n1?list=q%3Dada%26sort%3Dname%26dir%3Dasc");
    expect(context && neighborHref(null, context)).toBeNull();
  });
  it("goes back to the filtered list, or to the plain list without context", () => {
    expect(backToListHref(context)).toBe("/leads?q=ada&sort=name&dir=asc");
    expect(backToListHref(parseListContext(""))).toBe("/leads");
    expect(backToListHref(null)).toBe("/leads");
  });
});
