import { afterEach, describe, expect, it, vi } from "vitest";
import { gridRequest } from "@/app/(app)/tables/_lib/data/client";
import { callApi } from "./api-client";

const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

afterEach(() => vi.unstubAllGlobals());

describe("callApi", () => {
  it("sends JSON and returns the data with the status", async () => {
    const fetch = answer(201, { id: "a" });
    vi.stubGlobal("fetch", fetch);
    expect(await callApi("/api/x", "POST", { name: "n" })).toEqual({ ok: true, status: 201, data: { id: "a" }, error: null, issues: [], details: null });
    expect(fetch).toHaveBeenCalledWith("/api/x", expect.objectContaining({ headers: { "content-type": "application/json" }, body: '{"name":"n"}' }));
  });

  it("sends a FormData body as it is, without a JSON content type", async () => {
    const fetch = answer(200, {});
    vi.stubGlobal("fetch", fetch);
    const form = new FormData();
    await callApi("/api/x", "POST", form);
    expect(fetch).toHaveBeenCalledWith("/api/x", expect.objectContaining({ headers: undefined, body: form }));
  });

  it("reads the error, the issues and the body of a refusal", async () => {
    vi.stubGlobal("fetch", answer(422, { error: "Invalid input", issues: [{ message: "name: too long" }], code: "x" }));
    expect(await callApi("/api/x", "POST", {})).toMatchObject({ ok: false, status: 422, error: "Invalid input", issues: [{ message: "name: too long" }], details: { code: "x" } });
  });

  it("names an expired session and a call nobody answered", async () => {
    vi.stubGlobal("fetch", answer(401, {}));
    expect((await callApi("/api/x", "GET")).error).toBe("Your session expired. Sign in again.");
    // The route wrappers answer 401 with `{ error: "unauthorized" }`: a person reads the session line, not the code.
    vi.stubGlobal("fetch", answer(401, { error: "unauthorized" }));
    expect((await callApi("/api/x", "GET")).error).toBe("Your session expired. Sign in again.");
    // A 401 that says something else keeps its own words.
    vi.stubGlobal("fetch", answer(401, { error: "This invitation belongs to another account." }));
    expect((await callApi("/api/x", "GET")).error).toBe("This invitation belongs to another account.");
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    expect(await callApi("/api/x", "GET")).toMatchObject({ ok: false, status: 0, error: "Could not reach the server." });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new DOMException("stop", "AbortError"))));
    expect((await callApi("/api/x", "GET")).error).toBe("Cancelled.");
  });
});

describe("gridRequest", () => {
  it("joins the first issues into the error and keeps the failed body", async () => {
    vi.stubGlobal("fetch", answer(400, { error: "Invalid input", issues: [{ message: "a" }, { message: "b" }, { message: "c" }, { message: "d" }], conflicts: [] }));
    expect(await gridRequest("/api/grid/x", "POST", {})).toEqual({ ok: false, status: 400, data: null, error: "Invalid input a b c", failure: { error: "Invalid input", issues: [{ message: "a" }, { message: "b" }, { message: "c" }, { message: "d" }], conflicts: [] } });
  });
});
