import { planAgentRun, startAgentRun, type AgentRunPlan, type AgentRunTarget } from "@/contexts/grid/enrichment/application/agent-enrichment";
import { cancelRun, type RunReport } from "@/contexts/grid/enrichment/application/enrichment-run";
import { gridRunDeps } from "@/contexts/grid/enrichment/infrastructure/enrichment-composition";
import { withAgentUsage } from "@/contexts/tenancy/application/mcp-agent-usage";
import { auditSink } from "@/contexts/tenancy/infrastructure/audit";
import { agentUsageDeps } from "@/contexts/tenancy/infrastructure/mcp-composition";
import { actionTokenStale } from "@/shared/action-token";
import { ConflictError, viaMeta, type Actor } from "@/shared/errors";

/*
 * An agent's enrichment run: the plan and the run live in grid, the daily limit in tenancy, and this file joins them. The
 * run reserves its worst case, in cents at the prices an admin entered. Once queued, the cells run even if the limit
 * drops later; `stopAgentRun` and the app's Stop end what has not started.
 */

export const planEnrichment = (actor: Actor, target: AgentRunTarget): Promise<AgentRunPlan> => planAgentRun(gridRunDeps(), actor, target);

export async function runEnrichment(actor: Actor, target: AgentRunTarget, token: string): Promise<RunReport> {
  const deps = gridRunDeps();
  const plan = await planAgentRun(deps, actor, target);
  const [refusal] = plan.refusals;
  if (refusal) throw new ConflictError(refusal.message, { code: refusal.code });
  if (token !== plan.actionToken) throw actionTokenStale();
  // Nothing to run costs nothing, and a limit of 0 should not refuse it.
  if (plan.report.cells === 0) return plan.report;
  const amount = plan.report.worstCaseCostCents;
  const report = await withAgentUsage(agentUsageDeps(), actor, { kind: "spend_cents", amount }, () => startAgentRun(deps, actor, target, amount));
  await auditSink.record({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "grid.agent_run",
    entityType: "grid_table",
    entityId: target.tableId,
    meta: { columnKey: target.columnKey, cells: report.cells, reservedCents: amount, credits: report.worstCaseCredits, ...viaMeta(actor.via) },
  });
  return report;
}

export const stopAgentRun = (actor: Actor, tableId: string) => cancelRun(gridRunDeps(), actor, tableId);
