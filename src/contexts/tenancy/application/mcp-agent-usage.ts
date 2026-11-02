import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { agentUsageCapRefusal, agentUsageDay, agentUsageRefusal, type AgentUsageKind, type AgentUsageRefusal } from "../domain/mcp-agent-usage";

export interface AgentUsageReservation {
  organizationId: string;
  tokenId: string;
  day: string;
  kind: AgentUsageKind;
  amount: number;
}

export interface AgentUsageStore {
  /**
   * Reads the policy under the shared agent-send lock and adds the amount to today's row when it fits the limit, in one
   * short transaction. Answers null when it did, or why not.
   */
  reserve(reservation: AgentUsageReservation, now: Date): Promise<AgentUsageRefusal | "over_limit" | null>;
  release(reservation: AgentUsageReservation): Promise<void>;
}

export interface AgentUsageDeps {
  store: AgentUsageStore;
  now: () => Date;
}

const refused = (error: unknown) => error instanceof ConflictError || error instanceof ValidationError || error instanceof NotFoundError || error instanceof ForbiddenError;

/**
 * Runs an agent's action against one daily limit. The reservation commits before `run` starts, because a use case opens
 * its own transaction and one connection cannot serve both. A refusal gives the amount back. Any other failure keeps it:
 * the action may have run, and a limit that fills early is the safe mistake.
 */
export async function withAgentUsage<T>(deps: AgentUsageDeps, actor: Actor, request: { kind: AgentUsageKind; amount: number }, run: () => Promise<T>): Promise<T> {
  if (!actor.via) throw new ForbiddenError("This action counts against an agent's limits, and no agent made this call.");
  // A negative amount would give back what others reserved.
  if (!Number.isInteger(request.amount) || request.amount <= 0) throw new ValidationError("This action asks for a whole amount above 0.");
  const now = deps.now();
  const reservation: AgentUsageReservation = { organizationId: actor.organizationId, tokenId: actor.via.tokenId, day: agentUsageDay(now), ...request };
  const refusal = await deps.store.reserve(reservation, now);
  if (refusal === "over_limit") throw agentUsageCapRefusal(request.kind, now);
  if (refusal) throw agentUsageRefusal(refusal);
  try {
    return await run();
  } catch (error) {
    if (refused(error)) await deps.store.release(reservation);
    throw error;
  }
}
