import { afterEach, describe, expect, it, vi } from "vitest";
import { gridRequest } from "@/app/(app)/tables/_lib/data/client";
import { apiMessage, callApi } from "./api-client";

const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

afterEach(() => vi.unstubAllGlobals());

describe("callApi", () => {
  it("sends JSON and returns the data with the status", async () => {
    const fetch = answer(201, { id: "a" });
    vi.stubGlobal("fetch", fetch);
    expect(await callApi("/api/x", "POST", { name: "n" })).toEqual({ ok: true, status: 201, data: { id: "a" }, error: null, code: null, issues: [], details: null });
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
    vi.stubGlobal("fetch", answer(422, { error: "Invalid input", issues: [{ message: "name: too long" }], code: "validation" }));
    expect(await callApi("/api/x", "POST", {})).toMatchObject({ ok: false, status: 422, error: "Invalid input", code: "validation", issues: [{ message: "name: too long" }], details: { code: "validation" } });
  });

  it("names an expired session and a call nobody answered", async () => {
    // The route wrappers and the proxy answer 401 with the code `unauthenticated`: a person reads the session line.
    vi.stubGlobal("fetch", answer(401, { error: "Sign in to continue.", code: "unauthenticated" }));
    expect(await callApi("/api/x", "GET")).toMatchObject({ error: "Your session expired. Sign in again.", code: "unauthenticated" });
    // A 401 without a body comes from a layer in front of the app.
    vi.stubGlobal("fetch", answer(401, {}));
    expect(await callApi("/api/x", "GET")).toMatchObject({ error: "Your session expired. Sign in again.", code: "unauthenticated" });
    // A 401 that names no code and says something else keeps its own words.
    vi.stubGlobal("fetch", answer(401, { error: "This invitation belongs to another account." }));
    expect(await callApi("/api/x", "GET")).toMatchObject({ error: "This invitation belongs to another account.", code: null });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    expect(await callApi("/api/x", "GET")).toMatchObject({ ok: false, status: 0, error: "Could not reach the server.", code: null });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new DOMException("stop", "AbortError"))));
    expect((await callApi("/api/x", "GET")).error).toBe("Cancelled.");
  });

  it("says its own words for the codes it owns and the server's words for the rest", async () => {
    vi.stubGlobal("fetch", answer(409, { error: "Another change to this person is in progress. Try again in a moment.", code: "try_again" }));
    expect(await callApi("/api/x", "POST", {})).toMatchObject({ error: "MiaSDR is saving another change. Try again in a moment.", code: "try_again" });
    vi.stubGlobal("fetch", answer(409, { error: "Someone changed this deal since you opened it. Reload it and try again.", code: "stale_version", version: 4 }));
    expect(await callApi("/api/x", "PATCH", {})).toMatchObject({ error: "Someone changed this since you opened it. Reload the page and try again.", code: "stale_version", details: { version: 4 } });
    // The server's sentence carries data the browser does not have.
    vi.stubGlobal("fetch", answer(409, { error: "The stage holds 3 deals. Move them first.", code: "stage_in_use" }));
    expect(await callApi("/api/x", "DELETE")).toMatchObject({ error: "The stage holds 3 deals. Move them first.", code: "stage_in_use" });
    vi.stubGlobal("fetch", answer(404, { error: "Lead not found", code: "not_found" }));
    expect(await callApi("/api/x", "GET")).toMatchObject({ error: "Lead not found", code: "not_found" });
    expect(apiMessage("try_again", "Ada Lovelace")).toBe("MiaSDR is saving another change to Ada Lovelace. Try again in a moment.");
    expect(apiMessage("stale_version", "this deal")).toBe("Someone changed this deal since you opened it. Reload the page and try again.");
  });
});

describe("gridRequest", () => {
  it("joins the first issues into the error and keeps the failed body", async () => {
    vi.stubGlobal("fetch", answer(400, { error: "Invalid input", issues: [{ message: "a" }, { message: "b" }, { message: "c" }, { message: "d" }], conflicts: [] }));
    expect(await gridRequest("/api/grid/x", "POST", {})).toEqual({ ok: false, status: 400, data: null, error: "Invalid input a b c", failure: { error: "Invalid input", issues: [{ message: "a" }, { message: "b" }, { message: "c" }, { message: "d" }], conflicts: [] } });
  });
});
