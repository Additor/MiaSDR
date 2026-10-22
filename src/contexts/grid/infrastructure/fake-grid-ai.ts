import type { AnswerInput, AnswerOutput } from "../domain/ai-answer";
import type { GridAnswerer } from "./grid-ai";

/**
 * Fixed answers for demos and tests (AI_PROVIDER=fake). It never calls a network. Tests replace `answerWith` to return
 * anything, including answers outside the requested fields, so the closed-schema checks get exercised.
 */
export class FakeGridAi implements GridAnswerer {
  readonly provider = "fake";
  readonly model = "fake-1";
  answerCalls = 0;
  lastAnswerInput: AnswerInput | null = null;
  answerWith: ((input: AnswerInput) => unknown) | null = null;
  failWith: Error | null = null;

  /** Echoes the first cell into every text field, 0 into numbers and false into booleans. Email, url, date and json fields get fixed valid samples. */
  async answer(input: AnswerInput) {
    this.answerCalls += 1;
    this.lastAnswerInput = input;
    if (this.failWith) throw this.failWith;
    if (this.answerWith) return { output: this.answerWith(input) as AnswerOutput };
    const formula = fakeFormula(input);
    if (formula) return { output: { formula, explanation: "Joins the first columns of the current table." } };
    const first = input.cells[0]?.value ?? "";
    const output: AnswerOutput = {};
    for (const f of input.outputs) output[f.key] = fakeValue(f.type, first);
    return { output };
  }
}

/** Formula requests carry the workbook schema as the first cell. Joins the current table's first two column keys, so the answer parses. */
function fakeFormula(input: AnswerInput): string | null {
  if (!input.outputs.some((f) => f.key === "formula") || input.cells[0]?.key !== "workbook_schema") return null;
  try {
    const schema = JSON.parse(input.cells[0].value) as { current?: boolean; columns?: { key: string }[] }[];
    const keys = (schema.find((t) => t.current)?.columns ?? []).slice(0, 2).map((c) => `{{${c.key}}}`);
    return keys.length ? keys.join(' & " " & ') : null;
  } catch {
    return null;
  }
}

function fakeValue(type: string, first: string): string | number | boolean | null {
  if (type === "number") return 0;
  if (type === "boolean") return false;
  if (!first) return null;
  if (type === "email") return "fake@example.test";
  if (type === "url") return "https://example.test/fake";
  if (type === "date") return "2026-01-01";
  if (type === "json") return JSON.stringify({ fake: first.slice(0, 80) });
  return `fake: ${first.slice(0, 80)}`;
}
