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
    expect(Object.keys(publishedOutput(output).shape)).toEqual(["rows", "total", "error"]);
    expect(JSON.stringify(z.toJSONSchema(publishedOutput(output))).length).toBeLessThan(JSON.stringify(z.toJSONSchema(output)).length);
  });

  it("publishes a schema a refusal also fits, so a client that checks results keeps the refusal", () => {
    const schema = z.toJSONSchema(publishedOutput(output));
    expect(schema.required ?? []).toEqual([]);
    expect(publishedOutput(output).safeParse({ error: { code: "rate_limited", message: "Wait.", retryAfterSeconds: 3 } }).success).toBe(true);
    expect(publishedOutput(z.object({ error: z.string().nullable() })).safeParse({ error: null }).success).toBe(true);
  });

  it("refuses an oversize read but gives a write its answer, since the write already happened", async () => {
    const huge = { summary: "x".repeat(MAX_RESPONSE_TOKENS * 5), structured: {} };
    await expect(withinBudget(async () => huge)).rejects.toMatchObject({ details: { code: "answer_too_large" } });
    await expect(withinBudget(async () => huge, true)).resolves.toBe(huge);
  });

  it("holds each answer to the full schema and calls a mismatch a server bug", async () => {
    await expect(checkedOutput({ name: "t", output }, async () => ({ summary: "", structured: { rows: [{ id: "a" }], total: 1 } }))).resolves.toBeTruthy();
    const wrong = checkedOutput({ name: "t", output }, async () => ({ summary: "", structured: { rows: [{ id: 1 }], total: 1 } as never }));
    await expect(wrong).rejects.toThrow(/t answered outside its output schema/);
    await expect(wrong).rejects.not.toBeInstanceOf(z.ZodError);
  });
});
