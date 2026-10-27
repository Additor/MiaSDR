import { describe, expect, it } from "vitest";
import { draftingAbove, regenerateControl, reloadsAfter } from "./reply-panel";

const base = { status: "stale", decisionWaiting: false, drafting: false, busy: false, aiConfigured: true };

describe("draftingAbove", () => {
  it("says Drafting above an open draft while a draft job waits or runs", () => {
    expect(draftingAbove({ status: "stale" }, true)).toBe(true);
    expect(draftingAbove({ status: "failed" }, true)).toBe(true);
    expect(draftingAbove({ status: "awaiting_review" }, true)).toBe(true);
    expect(draftingAbove({ status: "stale" }, false)).toBe(false);
    // Without a draft the card says Drafting in place of the draft; a sent reply has nothing left to replace.
    expect(draftingAbove(null, true)).toBe(false);
    expect(draftingAbove({ status: "sent" }, true)).toBe(false);
  });
});

describe("regenerateControl", () => {
  it("leads under an out-of-date draft when nothing else waits", () => {
    expect(regenerateControl(base)).toEqual({ variant: "default", disabled: false });
    expect(regenerateControl({ ...base, decisionWaiting: true }).variant).toBe("outline");
    expect(regenerateControl({ ...base, status: "awaiting_review" }).variant).toBe("outline");
  });

  it("is outline and off while a draft job writes the next draft", () => {
    expect(regenerateControl({ ...base, drafting: true })).toEqual({ variant: "outline", disabled: true });
    expect(regenerateControl({ ...base, status: "failed", drafting: true }).disabled).toBe(true);
  });

  it("is off while a request runs or the AI is off", () => {
    expect(regenerateControl({ ...base, busy: true }).disabled).toBe(true);
    expect(regenerateControl({ ...base, aiConfigured: false }).disabled).toBe(true);
  });
});

describe("reloadsAfter", () => {
  it("reloads the thread after a conflict only", () => {
    expect(reloadsAfter({ ok: false, status: 409 })).toBe(true);
    expect(reloadsAfter({ ok: false, status: 422 })).toBe(false);
    expect(reloadsAfter({ ok: true, status: 201 })).toBe(false);
  });
});
