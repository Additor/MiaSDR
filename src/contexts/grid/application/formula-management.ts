import { ConflictError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { effectiveColumnType, TEXT_LIKE_TYPES } from "../domain/column-types";
import { compileFormula, evaluateFormula, type FormulaValue } from "../domain/formula";
import { GRID_LIMITS } from "./limits";
import type { ColumnRecord, GridDeps } from "./ports";

type Deps = Pick<GridDeps, "structure" | "columns" | "formulas">;

/** Keys of text-like columns. A formula reads a blank one as "" so joins do not print "null". */
export function textColumnKeys(columns: readonly ColumnRecord[]): Set<string> {
  return new Set(columns.filter((c) => TEXT_LIKE_TYPES.has(effectiveColumnType(c))).map((c) => c.key));
}

function parse(expression: unknown, columns: readonly ColumnRecord[]) {
  if (typeof expression !== "string") throw new ValidationError("expression must be text");
  const text = expression.trim();
  if (!text) throw new ValidationError("expression is required");
  if (text.length > GRID_LIMITS.formulaChars) throw new ValidationError("expression is too long");
  const compiled = compileFormula(text);
  if (!compiled.ok) throw new ValidationError(compiled.error);
  const known = new Set(columns.map((c) => c.key));
  const unknown = compiled.formula.references.cells.find((key) => !known.has(key));
  if (unknown) throw new ValidationError(`The formula references an unknown column "${unknown}"`);
  return compiled.formula;
}

export interface FormulaPreview {
  ok: true;
  value: FormulaValue;
  rowId: string;
  /** The row's place in the grid, counted from 1. */
  rowNumber: number;
}

/**
 * Evaluates a formula against one row without writing anything: the row the person picked, or the
 * first row. The evaluation is pure, so a preview never reaches a provider or the queue.
 */
export async function previewFormula(deps: Deps, actor: Actor, tableId: string, input: { expression: unknown; rowId?: string }): Promise<FormulaPreview> {
  const org = actor.organizationId;
  const [table, columns] = await Promise.all([deps.structure.getTable(org, tableId), deps.columns.list(org, tableId)]);
  if (!table) throw new NotFoundError("Table not found");
  const formula = parse(input.expression, columns);
  const target = await deps.formulas.previewRow(org, tableId, input.rowId);
  if (!target) throw new NotFoundError("Preview row not found");
  const lookups = await deps.formulas.lookupRegistry(org, tableId, formula.references.lookups);
  const timeZone = formula.references.usesDates ? await deps.formulas.organizationTimeZone(org) : undefined;
  const result = evaluateFormula(formula, target.row.cells, { textKeys: textColumnKeys(columns), lookups, now: new Date(), timeZone });
  if (!result.ok) throw new ValidationError(result.error);
  return { ok: true, value: result.value, rowId: target.row.id, rowNumber: target.rowNumber };
}

const LANGUAGE_RULES = [
  "Write one formula for a spreadsheet-like grid. The language is a small expression language, not Excel and not JavaScript.",
  "Reference a column of the current table as {{key}}, using only keys from the schema. A blank text cell reads as an empty string and any other blank cell as null.",
  "Operators: + - * / % ^, & joins text, comparisons == != < > <= >=, && || !, and cond ? a : b. A + with text on either side joins text.",
  "Functions: IF IFS SWITCH AND OR NOT IFERROR ISERROR COALESCE ISBLANK ISNUMBER ISTEXT CONCATENATE TEXTJOIN JOIN UPPER LOWER PROPER TRIM LEN LEFT RIGHT MID SUBSTITUTE FIND CONTAINS STARTSWITH ENDSWITH SPLIT REPEAT DOMAIN TEXT NUMBER ABS ROUND ROUNDUP ROUNDDOWN FLOOR CEILING INT MOD POWER SQRT SUM AVERAGE MIN MAX COUNT SEQUENCE INDEX JSON_VALUE TODAY NOW DATE YEAR MONTH DAY DATEDIF LOOKUP.",
  'Dates are ISO text such as 2026-03-05, in the organization time zone. TODAY() gives today as text, DATEDIF(start, end, "D") counts days ("M" months, "Y" years), TEXT(date, "yyyy-mm-dd") formats a date and TEXT(n, "#,##0.00") formats a number. JSON_VALUE({{cell}}, "a.b[0]") reads a field from JSON text and INDEX(list, 1) reads a list item. IFS(test1, value1, test2, value2, TRUE, fallback) picks the first true test.',
  'For another table of the workbook use LOOKUP("Table name", {{keyOfCurrentRow}}, "Lookup column name", "Return column name") with an optional fifth default value. The table and column names must be quoted text from the schema.',
  "There are no variables, no property access, no statements and no network calls. Return the expression only, with no leading equals sign and no markdown.",
].join("\n");

const MAX_SCHEMA_TABLES = 20;
const MAX_SCHEMA_COLUMNS = 100;

/**
 * Asks the organization's AI for a formula, then checks it: it must parse, name only known columns and
 * evaluate without a structural error on a sample row. Retries once with the problem as feedback.
 * The AI runs behind `deps.formulaAuthor`; without a configured provider this answers 409.
 */
export async function generateFormula(
  deps: Deps & Pick<GridDeps, "formulaAuthor">,
  actor: Actor,
  tableId: string,
  input: { prompt: unknown; currentExpression?: unknown },
) {
  const org = actor.organizationId;
  if (typeof input.prompt !== "string" || !input.prompt.trim()) throw new ValidationError("Describe the formula you want");
  if (input.prompt.length > GRID_LIMITS.formulaPromptChars) throw new ValidationError("The formula request is too long");
  if (input.currentExpression !== undefined && (typeof input.currentExpression !== "string" || input.currentExpression.length > GRID_LIMITS.formulaChars)) {
    throw new ValidationError("currentExpression must be text of reasonable length");
  }
  const table = await deps.structure.getTable(org, tableId);
  if (!table) throw new NotFoundError("Table not found");
  const author = await deps.formulaAuthor.forOrganization(org);
  if (!author) throw new ConflictError("AI is not configured. Connect an AI provider in Settings, Integrations.");

  const tables = (await deps.structure.listTables(org, table.workbookId)).slice(0, MAX_SCHEMA_TABLES);
  const schema = await Promise.all(
    tables.map(async (t) => ({
      table: t.name,
      current: t.id === tableId,
      columns: (await deps.columns.list(org, t.id)).slice(0, MAX_SCHEMA_COLUMNS).map((c) => ({ name: c.name, key: c.key, type: effectiveColumnType(c) })),
    })),
  );
  const columns = await deps.columns.list(org, tableId);
  const sample = (await deps.formulas.previewRow(org, tableId))?.row.cells ?? {};

  let feedback: string | undefined;
  let lastProblem = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const answer = await author.complete({ schema, request: input.prompt.trim(), currentExpression: input.currentExpression as string | undefined, feedback });
    const formula = answer.formula.trim().replace(/^=\s*/, "");
    const problem = formulaProblem(formula, columns, sample);
    if (!problem) return { formula, explanation: answer.explanation.trim() || "Generated from your request." };
    lastProblem = problem;
    feedback = `Your previous formula was rejected.\nFormula: ${formula.slice(0, 500)}\nProblem: ${problem}\nReturn a corrected formula.`;
  }
  throw new ValidationError(`The AI could not produce a working formula (${lastProblem}). Try rephrasing the request.`);
}

export { LANGUAGE_RULES };

/** Null when the formula parses, names known columns and runs on the sample without a structural error. */
export function formulaProblem(formula: string, columns: readonly ColumnRecord[], sample: Record<string, unknown>): string | null {
  if (!formula || formula.length > GRID_LIMITS.formulaChars) return "the formula is empty or too long";
  const compiled = compileFormula(formula);
  if (!compiled.ok) return compiled.error;
  const known = new Set(columns.map((c) => c.key));
  const unknown = compiled.formula.references.cells.find((key) => !known.has(key));
  if (unknown) return `unknown column "${unknown}"`;
  const result = evaluateFormula(compiled.formula, sample, { textKeys: textColumnKeys(columns), now: new Date() });
  // A data problem on the sample row (text in a number) is not the formula's fault. An unknown function is.
  if (!result.ok && /^Unknown function/.test(result.error)) return result.error;
  return null;
}
