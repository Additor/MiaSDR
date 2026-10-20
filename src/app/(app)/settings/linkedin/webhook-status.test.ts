import { describe, expect, it } from "vitest";
import { webhookBadge } from "./webhook-status";

const at = "2026-10-15T10:00:00.000Z";

describe("webhookBadge", () => {
  it("says Not registered without a stored result or with an empty one", () => {
    expect(webhookBadge(null).label).toBe("Not registered");
    expect(webhookBadge({ at, hooks: [] }).label).toBe("Not registered");
  });

  it("counts registered hooks", () => {
    const hooks = [{ name: "a", status: "registered" as const }, { name: "b", status: "registered" as const }];
    expect(webhookBadge({ at, hooks })).toEqual({ label: "2 registered", variant: "secondary" });
  });

  it("says Registration failed when any hook failed", () => {
    const hooks = [{ name: "a", status: "registered" as const }, { name: "b", status: "failed" as const, error: "x" }];
    expect(webhookBadge({ at, hooks })).toEqual({ label: "Registration failed", variant: "destructive" });
  });
});
