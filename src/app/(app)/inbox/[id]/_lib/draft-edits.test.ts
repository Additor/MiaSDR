import { describe, expect, it, vi } from "vitest";
import { afterSavingEdits, registerDraftEdits } from "./draft-edits";

describe("afterSavingEdits", () => {
  it("saves the editor's edits before the step that retires the draft", async () => {
    const order: string[] = [];
    const cleanup = registerDraftEdits(async () => {
      order.push("save");
      return null;
    });
    const result = await afterSavingEdits(async () => {
      order.push("step");
      return { ok: true, error: null };
    });
    cleanup();
    expect(order).toEqual(["save", "step"]);
    expect(result.ok).toBe(true);
  });

  it("stops before the step when the edits did not save", async () => {
    const step = vi.fn(async () => ({ ok: true, error: null }));
    const cleanup = registerDraftEdits(async () => "The draft changed. Reload it.");
    const result = await afterSavingEdits(step);
    cleanup();
    expect(step).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, error: "Your draft edits were not saved, so nothing changed. The draft changed. Reload it." });
  });

  it("runs the step when no editor is open", async () => {
    const result = await afterSavingEdits(async () => ({ ok: true, error: null }));
    expect(result.ok).toBe(true);
  });
});
