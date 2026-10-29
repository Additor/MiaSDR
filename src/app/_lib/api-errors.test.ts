import { describe, expect, it } from "vitest";
import { apiError } from "./api-errors";

describe("apiError", () => {
  it("writes the sentence, the status's code and the details", async () => {
    const response = apiError(422, "Pick a stage.", { issues: [{ message: "stage: required" }] });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "Pick a stage.", code: "validation", issues: [{ message: "stage: required" }] });
  });

  it("takes a code from the details, and never an error from them", async () => {
    const response = apiError(409, "Someone changed this deal.", { code: "stale_version", version: 4, error: "a field named error" });
    expect(await response.json()).toEqual({ error: "Someone changed this deal.", code: "stale_version", version: 4 });
    expect(await apiError(409, "Taken.", { code: 7 }).json()).toEqual({ error: "Taken.", code: "conflict" });
  });
});
