import { describe, expect, it } from "vitest";
import { submitSteps } from "./change-type";

describe("submitSteps", () => {
  it("changes the type and stops on the first submit", () => {
    expect(submitSteps(null, "t-stop", "stop")).toEqual({ change: true, stop: true });
    expect(submitSteps(null, "t-demo", "change")).toEqual({ change: true, stop: false });
  });

  it("only stops on a retry after the type changed and the stop failed", () => {
    expect(submitSteps("t-stop", "t-stop", "stop")).toEqual({ change: false, stop: true });
  });

  it("changes again when the person picks another type", () => {
    expect(submitSteps("t-stop", "t-demo", "change")).toEqual({ change: true, stop: false });
  });
});
