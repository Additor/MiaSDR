import { describe, expect, it, vi } from "vitest";
import { withGridFocus } from "./history-focus";

describe("withGridFocus", () => {
  it("runs the history step and then returns focus to the grid", () => {
    const calls: string[] = [];
    withGridFocus(() => calls.push("undo"), () => calls.push("focus"))();
    expect(calls).toEqual(["undo", "focus"]);
  });

  it("does nothing until the handler is called", () => {
    const action = vi.fn();
    const refocus = vi.fn();
    withGridFocus(action, refocus);
    expect(action).not.toHaveBeenCalled();
    expect(refocus).not.toHaveBeenCalled();
  });
});
