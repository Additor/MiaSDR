import type { AiProviderResolver } from "@/contexts/conversations/ai/application/ai-ports";
import { aiResolver } from "@/contexts/conversations/ai/infrastructure/ai-composition";
import { AiError } from "@/contexts/conversations/ai/application/ai-ports";
import { ConflictError, ValidationError } from "@/shared/errors";
import { LANGUAGE_RULES } from "../application/formula-management";
import type { FormulaAuthor } from "../application/ports";

/**
 * Formula help through the organization's AI provider (the same resolver the reply drafts use).
 * The member's request is the instruction. Column names, sample values and the current formula
 * travel as fenced cells, so text a teammate typed into a cell cannot change the output shape:
 * the answer is a closed object with a formula and an explanation, and the use case checks the
 * formula before it reaches anyone.
 */
export function createFormulaAuthor(resolver: AiProviderResolver = aiResolver): FormulaAuthor {
  return {
    async forOrganization(organizationId) {
      const provider = await resolver.forOrganization(organizationId);
      if (!provider) return null;
      const answer = provider.answer?.bind(provider);
      if (!answer) throw new ConflictError("The configured AI provider cannot write formulas.");
      return {
        async complete(input) {
          const cells = [{ key: "workbook_schema", value: JSON.stringify(input.schema).slice(0, 20_000) }];
          if (input.currentExpression) cells.push({ key: "current_formula", value: input.currentExpression });
          if (input.feedback) cells.push({ key: "feedback", value: input.feedback });
          try {
            const { output } = await answer({
              instruction: `${LANGUAGE_RULES}\n\nThe person asks: ${input.request}`,
              cells,
              outputs: [
                { key: "formula", type: "text", description: "The formula expression only." },
                { key: "explanation", type: "text", description: "One sentence on what the formula does." },
              ],
            });
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
