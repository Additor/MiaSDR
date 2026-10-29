import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "./proxy";

describe("proxy", () => {
  it("answers an API call without the session cookie with the 401 body the route wrappers write", async () => {
    const response = proxy(new NextRequest("http://localhost/api/leads"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Sign in to continue.", code: "unauthenticated" });
  });

  it("sends a page request without the cookie to sign-in with the path to return to", () => {
    const response = proxy(new NextRequest("http://localhost/leads?page=2"));
    expect(response.headers.get("location")).toBe("http://localhost/sign-in?next=%2Fleads");
  });
});
