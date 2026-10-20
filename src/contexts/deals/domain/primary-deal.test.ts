import { describe, expect, it } from "vitest";
import { primaryDeal } from "./primary-deal";

const deal = (id: string, stageKind: "open" | "won" | "lost", created: string) => ({ id, stageKind, createdAt: new Date(created) });

describe("primaryDeal", () => {
  it("is null without deals", () => {
    expect(primaryDeal([])).toBeNull();
  });

  it("puts an open deal before a newer closed one", () => {
    expect(primaryDeal([deal("a", "won", "2026-10-10"), deal("b", "open", "2026-01-01")])?.id).toBe("b");
  });

  it("takes the newest within open or closed deals", () => {
    expect(primaryDeal([deal("a", "open", "2026-01-01"), deal("b", "open", "2026-05-01")])?.id).toBe("b");
    expect(primaryDeal([deal("a", "lost", "2026-05-01"), deal("b", "won", "2026-01-01")])?.id).toBe("a");
  });

  it("breaks a tie on the higher id, whatever the input order", () => {
    expect(primaryDeal([deal("a", "open", "2026-01-01"), deal("b", "open", "2026-01-01")])?.id).toBe("b");
    expect(primaryDeal([deal("b", "open", "2026-01-01"), deal("a", "open", "2026-01-01")])?.id).toBe("b");
  });
});
