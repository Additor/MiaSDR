import { describe, expect, it } from "vitest";
import { aiConfigSchema } from "../domain/enrichment-config";
import { aiConfigProblem } from "./enrichment-columns";

const problem = (config: unknown) => {
  const parsed = aiConfigSchema.safeParse(config);
  if (parsed.success) throw new Error("expected the config to fail");
  return aiConfigProblem(parsed.error.issues);
};

describe("aiConfigProblem", () => {
  const ok = { prompt: "Summarize {{a}}", outputs: [{ key: "answer", type: "text" }], outputColumns: { answer: "c1" } };

  it("names the prompt and the output field in plain words, without schema paths", () => {
    expect(problem({ ...ok, prompt: "" })).toBe("The prompt must be 1 to 8,000 characters.");
    expect(problem({ ...ok, outputs: [{ key: "Bad Key", type: "text" }] })).toBe("Output field 1: the key must start with a lowercase letter and use only letters, numbers and underscores, up to 40 characters.");
    expect(problem({ ...ok, outputs: [] })).toBe("An AI column needs 1 to 12 output fields.");
  });

  it("falls back to a general sentence for anything else", () => {
    expect(problem({ ...ok, extra: 1 })).toBe("The AI column settings are not valid. Check each field and try again.");
  });
});
