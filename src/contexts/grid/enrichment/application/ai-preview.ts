import { NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { coerceAiOutput } from "../../domain/ai-output-coerce";
import type { GridDeps } from "../../application/ports";
import type { AiConfig } from "../domain/enrichment-config";
import { cellText, ownCell, tokensIn } from "../domain/enrichment-templates";
import { GridAiError, type CellAnswerer } from "./enrichment-ports";

export interface AiPreviewDeps extends Pick<GridDeps, "structure" | "columns" | "rows"> {
  ai: CellAnswerer;
}

export interface AiPreview {
  rowId: string;
  /** Each field's answer as the column would store it, or why the column would refuse it. */
  fields: Array<{ key: string; value: unknown; error: string | null }>;
  provider: string;
  model: string;
}

/**
 * Asks the AI one row's question before the column exists, so a person can read the answer and change the prompt
 * first. It is one paid call on the organization's AI key and writes nothing: no cell, no ledger row.
 */
export async function previewAiAnswer(deps: AiPreviewDeps, actor: Actor, tableId: string, input: { prompt: string; outputs: AiConfig["outputs"]; rowId?: string }): Promise<AiPreview> {
  const org = actor.organizationId;
  if (!(await deps.structure.getTable(org, tableId))) throw new NotFoundError("Table not found");
  const columns = await deps.columns.list(org, tableId);
  const referenced = tokensIn(input.prompt);
  const known = new Set(columns.map((c) => c.key));
  const missing = referenced.find((k) => !known.has(k));
  if (missing) throw new ValidationError(`The prompt mentions {{${missing}}}, which is not a column of this table.`);

  const [row] = input.rowId ? await deps.rows.listByIds(org, tableId, [input.rowId]) : await deps.rows.list(org, tableId, { limit: 1, offset: 0, columns: columns.map((c) => ({ key: c.key, type: c.type })) });
  if (!row) throw new ValidationError(input.rowId ? "That row is not in this table." : "Add a row first: the test runs on the first row.");
  const cells = referenced.map((key) => ({ key, value: cellText(ownCell(row.cells, key)).trim() })).filter((c) => c.value !== "");
  if (referenced.length > 0 && cells.length === 0) throw new ValidationError("Every column the prompt reads is empty in this row. Fill one, or test on another row.");

  try {
    const answered = await deps.ai.answer(org, { instruction: input.prompt, cells, outputs: input.outputs });
    const fields = input.outputs.map((f) => {
      const coerced = coerceAiOutput(f.type, answered.output[f.key]);
      return coerced.ok ? { key: f.key, value: coerced.value ?? null, error: null } : { key: f.key, value: null, error: coerced.message };
    });
    return { rowId: row.id, fields, provider: answered.provider, model: answered.model };
  } catch (error) {
    if (error instanceof GridAiError) throw new ValidationError(error.message);
    throw error;
  }
}
