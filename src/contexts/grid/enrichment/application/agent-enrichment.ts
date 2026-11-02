import { actionToken, stateDigest } from "@/shared/action-token";
import { NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { autoRunDescendants, RUNNABLE_TYPES } from "../domain/enrichment-cascade";
import { estimateColumn } from "./enrichment-cost";
import { requestRun, type RunDeps, type RunReport } from "./enrichment-run";

/*
 * What an agent's enrichment run must meet on top of a person's rules ("Agent spending" in docs/decisions.md). The run
 * reserves its worst case against a daily limit, so the worst case has to be a real number: a column with no price would
 * count as free, and an AI column spends on the organization's AI key, outside these totals. Auto-run columns the run
 * sets off count too, so they meet the same checks.
 */

/** Rows one call may name, or pick from the top of the table. */
export const MAX_AGENT_RUN_ROW_IDS = 500;
export const MAX_AGENT_RUN_FIRST_N = 2000;

export interface AgentRunTarget {
  tableId: string;
  columnKey: string;
  rowIds?: string[];
  firstN?: number;
}

export interface AgentRunRefusal {
  code: "agent_ai_column" | "agent_price_unset" | "agent_column_not_ready" | "agent_run_too_large";
  message: string;
}

export interface AgentRunPlan {
  report: RunReport;
  refusals: AgentRunRefusal[];
  /** Null when a refusal stands. */
  actionToken: string | null;
}

/** An agent runs only empty cells, so a call never pays again for what is already there. */
const agentRequest = (target: AgentRunTarget) => ({ columnKey: target.columnKey, rowIds: target.rowIds, firstN: target.firstN, onlyEmpty: true });

/** What the run would do, and what stops it. It queues nothing and reserves nothing. */
export async function planAgentRun(deps: RunDeps, actor: Actor, target: AgentRunTarget): Promise<AgentRunPlan> {
  const org = actor.organizationId;
  const tableAutoRun = await deps.store.tableAutoRun(org, target.tableId);
  if (tableAutoRun === null) throw new NotFoundError("Table not found");
  const columns = await deps.store.listColumns(org, target.tableId);
  const column = columns.find((c) => c.key === target.columnKey && RUNNABLE_TYPES.has(c.type));
  if (!column) throw new ValidationError(`"${target.columnKey}" is not a runnable column.`);
  const dependents = tableAutoRun ? autoRunDescendants(columns, [column.key]) : [];
  const involved = [column, ...dependents.map((d) => columns.find((c) => c.key === d.key)!)];

  const refusals: AgentRunRefusal[] = [];
  for (const c of involved) {
    if (c.type === "ai") {
      refusals.push({ code: "agent_ai_column", message: `“${c.name}” is an AI column, or one this run sets off. Agents run provider columns only; a person runs AI columns.` });
      continue;
    }
    try {
      const estimate = await estimateColumn(deps, org, c, true);
      const free = estimate.providers.filter((p) => p.cents === 0);
      if (free.length > 0) refusals.push({ code: "agent_price_unset", message: `“${c.name}” calls ${free.map((p) => p.name).join(", ")} with no price set. An owner or admin enters the price under Settings, Integrations, so the daily limit can count it.` });
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      refusals.push({ code: "agent_column_not_ready", message: error.message });
    }
  }
  const report = refusals.length > 0 ? null : await requestRun(deps, actor, target.tableId, { ...agentRequest(target), dryRun: true });
  if (!report) return { report: await emptyReport(deps, actor, target), refusals, actionToken: null };
  if (report.problem) refusals.push({ code: "agent_run_too_large", message: report.problem });
  const state = stateDigest([tableAutoRun, report.cells, report.rows, report.worstCaseCostCents, report.worstCaseCredits, report.providers, involved.map((c) => [c.key, c.updatedAt])]);
  return { report, refusals, actionToken: refusals.length > 0 ? null : actionToken("run_enrichment", tokenTarget(target), state) };
}

/** The counts a refused plan shows: a column that cannot run has nothing to estimate. */
async function emptyReport(deps: RunDeps, actor: Actor, target: AgentRunTarget): Promise<RunReport> {
  return { queued: 0, rows: 0, columns: [target.columnKey], columnNames: [], cells: 0, aiCells: 0, worstCaseCostCents: 0, worstCaseCredits: 0, providers: [], dependents: [], jobs: await deps.store.counts(actor.organizationId, target.tableId) };
}

/** The rows belong in the token: a token for three rows says nothing about thirty. */
const tokenTarget = (target: AgentRunTarget) => `${target.tableId}:${target.columnKey}:${target.firstN ?? ""}:${stateDigest(target.rowIds ?? null)}`;

/**
 * Queues the run. `maxCostCents` holds it to what the caller reserved, so rows that changed since the plan refuse rather
 * than spend more.
 */
export const startAgentRun = (deps: RunDeps, actor: Actor, target: AgentRunTarget, reservedCents: number): Promise<RunReport> =>
  requestRun(deps, actor, target.tableId, { ...agentRequest(target), maxCostCents: reservedCents });
