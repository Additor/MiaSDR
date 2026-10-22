import { AiError } from "@/contexts/ai/domain/ai-error";
import { createGridAnswererResolver, type GridAnswererResolver } from "./grid-ai";
import { ConflictError, ValidationError } from "@/shared/errors";
import { LANGUAGE_RULES } from "../application/formula-management";
import type { FormulaAuthor } from "../application/ports";

/**
 * Formula help through the organization's configured language model, asked the grid's row question.
 * The member's request is the instruction. Column names, sample values and the current formula
 * travel as fenced cells, so text a teammate typed into a cell cannot change the output shape:
 * the answer is a closed object with a formula and an explanation, and the use case checks the
 * formula before it reaches anyone.
 */
export function createFormulaAuthor(resolver: GridAnswererResolver = createGridAnswererResolver()): FormulaAuthor {
  return {
    async forOrganization(organizationId) {
      const answerer = await resolver.forOrganization(organizationId);
      if (!answerer) return null;
      return {
        async complete(input) {
          const cells = [{ key: "workbook_schema", value: JSON.stringify(input.schema).slice(0, 20_000) }];
          if (input.currentExpression) cells.push({ key: "current_formula", value: input.currentExpression });
          if (input.feedback) cells.push({ key: "feedback", value: input.feedback });
          try {
            const { output } = await answerer.answer({
              instruction: `${LANGUAGE_RULES}\n\nThe person asks: ${input.request}`,
              cells,
              outputs: [
                { key: "formula", type: "text", description: "The formula expression only." },
                { key: "explanation", type: "text", description: "One sentence on what the formula does." },
              ],
            }, "grid.formula");
            const formula = typeof output.formula === "string" ? output.formula : "";
            const explanation = typeof output.explanation === "string" ? output.explanation : "";
            return { formula, explanation };
          } catch (error) {
            if (error instanceof AiError) {
              if (error.kind === "permanent") throw new ConflictError(`The AI provider refused the request: ${error.message}`);
              throw new ValidationError(`The AI service did not answer. Try again in a moment. (${error.message})`);
            }
            throw error;
          }
        },
      };
    },
  };
}
