import { describe, expect, it } from "vitest";
import { ConflictError } from "@/shared/errors";
import { withinBudget } from "./define";
import { MAX_RESPONSE_TOKENS } from "./output";

describe("withinBudget", () => {
  it("passes an answer within the budget and refuses a larger one with a code the agent can act on", async () => {
    const small = { summary: "ok", structured: { rows: ["a"] } };
    await expect(withinBudget(async () => small)).resolves.toBe(small);
    const huge = { summary: "big", structured: { text: "x".repeat(MAX_RESPONSE_TOKENS * 5) } };
    const refused = withinBudget(async () => huge);
    await expect(refused).rejects.toBeInstanceOf(ConflictError);
    await expect(refused).rejects.toMatchObject({ details: { code: "answer_too_large" } });
  });
});
