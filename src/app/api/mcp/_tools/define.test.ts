import { describe, expect, it } from "vitest";
import { ConflictError } from "@/shared/errors";
import { z } from "zod";
import { checkedOutput, publishedOutput, withinBudget } from "./define";
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

describe("output schemas", () => {
  const output = z.object({ rows: z.array(z.object({ id: z.string() })), total: z.number() });

  it("publishes the top-level keys only", () => {
    expect(Object.keys(publishedOutput(output).shape)).toEqual(["rows", "total"]);
    expect(JSON.stringify(z.toJSONSchema(publishedOutput(output))).length).toBeLessThan(JSON.stringify(z.toJSONSchema(output)).length);
  });

  it("holds each answer to the full schema and calls a mismatch a server bug", async () => {
    await expect(checkedOutput({ name: "t", output }, async () => ({ summary: "", structured: { rows: [{ id: "a" }], total: 1 } }))).resolves.toBeTruthy();
    const wrong = checkedOutput({ name: "t", output }, async () => ({ summary: "", structured: { rows: [{ id: 1 }], total: 1 } as never }));
    await expect(wrong).rejects.toThrow(/t answered outside its output schema/);
    await expect(wrong).rejects.not.toBeInstanceOf(z.ZodError);
  });
});
