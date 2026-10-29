import { afterEach, describe, expect, it, vi } from "vitest";
import { orThrow, runApiAction } from "./api-action";
import { callApi } from "./api-client";

const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

afterEach(() => vi.unstubAllGlobals());

describe("runApiAction", () => {
  it("returns the data of a success and refreshes the page", async () => {
    vi.stubGlobal("fetch", answer(200, { id: "a" }));
    const refresh = vi.fn();
    const result = await runApiAction(callApi<{ id: string }>("/api/x", "POST", {}), { refresh });
    expect(result).toEqual({ ok: true, status: 200, data: { id: "a" } });
    expect(refresh).toHaveBeenCalledOnce();
    expect(orThrow(result)).toEqual({ id: "a" });
  });

  it("answers null data for a change without a body, and a failure when the screen expects data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    expect(await runApiAction(callApi("/api/x", "DELETE"))).toEqual({ ok: true, status: 204, data: null });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const refresh = vi.fn();
    const expected = await runApiAction(callApi<{ id: string }>("/api/x", "POST", {}), { refresh, expectData: true });
    expect(expected).toMatchObject({ ok: false, status: 204, error: "MiaSDR saved the change but sent back nothing to show. Reload the page.", code: null });
    // The change went through, so the page reloads.
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("returns the server's sentence for a refused input and keeps the page as it is", async () => {
    vi.stubGlobal("fetch", answer(422, { error: "Invalid input", code: "validation", issues: [{ message: "name: too long" }] }));
    const refresh = vi.fn();
    const result = await runApiAction(callApi("/api/x", "POST", {}), { refresh });
    expect(result).toMatchObject({ ok: false, status: 422, error: "Invalid input", code: "validation", issues: [{ message: "name: too long" }] });
    expect(refresh).not.toHaveBeenCalled();
    // A ConfirmDialog stays open on a rejected promise and shows its message.
    expect(() => orThrow(result)).toThrow("Invalid input");
  });

  it("refreshes after a 404, since the thing on screen is gone", async () => {
    vi.stubGlobal("fetch", answer(404, { error: "Invitation not found", code: "not_found" }));
    const refresh = vi.fn();
    expect(await runApiAction(callApi("/api/x", "DELETE"), { refresh })).toMatchObject({ ok: false, status: 404, code: "not_found" });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("lets the screen say its own words for a conflict code and refreshes", async () => {
    vi.stubGlobal("fetch", answer(409, { error: "Someone changed this deal since you opened it. Reload it and try again.", code: "stale_version", version: 7 }));
    const refresh = vi.fn();
    const seen: number[] = [];
    const result = await runApiAction(callApi("/api/x", "PATCH", {}), {
      refresh,
      onConflict: {
        stale_version: (failure) => {
          seen.push(failure.details?.version as number);
          return "The page now shows the latest version. Save again.";
        },
      },
    });
    expect(result).toMatchObject({ ok: false, status: 409, code: "stale_version", error: "The page now shows the latest version. Save again.", details: { version: 7 } });
    expect(seen).toEqual([7]);
    expect(refresh).toHaveBeenCalledOnce();

    // A handler that returns nothing keeps the sentence, and a code without a handler keeps its own.
    vi.stubGlobal("fetch", answer(409, { error: "The stage holds 3 deals. Move them first.", code: "stage_in_use" }));
    const quiet = await runApiAction(callApi("/api/x", "DELETE"), { onConflict: { stale_version: () => "unused", stage_in_use: () => undefined } });
    expect(quiet).toMatchObject({ ok: false, error: "The stage holds 3 deals. Move them first.", code: "stage_in_use" });
    vi.stubGlobal("fetch", answer(409, { error: "Another change to this person is in progress. Try again in a moment.", code: "try_again" }));
    expect(await runApiAction(callApi("/api/x", "POST", {}), { onConflict: { stale_version: () => "unused" } })).toMatchObject({ error: "MiaSDR is saving another change. Try again in a moment." });
  });

  it("names an expired session without reloading the page", async () => {
    vi.stubGlobal("fetch", answer(401, { error: "Sign in to continue.", code: "unauthenticated" }));
    const refresh = vi.fn();
    expect(await runApiAction(callApi("/api/x", "POST", {}), { refresh })).toMatchObject({ ok: false, status: 401, error: "Your session expired. Sign in again.", code: "unauthenticated" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("says the server was not reached and keeps the page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    const refresh = vi.fn();
    const result = await runApiAction(callApi("/api/x", "POST", {}), { refresh });
    expect(result).toEqual({ ok: false, status: 0, error: "Could not reach the server.", code: null, issues: [], details: null });
    expect(refresh).not.toHaveBeenCalled();
    expect(() => orThrow(result)).toThrow("Could not reach the server.");
  });
});
