import { taskDeps } from "@/contexts/conversations/actions/infrastructure/task-composition";
import { listDealStages } from "@/contexts/deals/application/deal-stages";
import { dealsDeps } from "@/contexts/deals/infrastructure/deals-composition";
import type { Actor } from "@/shared/errors";
import type { DealMemberOption, DealStageList } from "./deal-form";

/**
 * What the deal dialogs need from the server: the stages and the owner choices (the organization's members, the same
 * list the tasks panel assigns from). Call it from a server component that already awaited `connection()`.
 */
export async function dealDialogData(actor: Actor): Promise<{ stages: DealStageList; members: DealMemberOption[]; currentUserId: string }> {
  const [stages, members] = await Promise.all([listDealStages(dealsDeps(), actor), taskDeps().store.members(actor.organizationId)]);
  return {
    stages: { virtual: stages.virtual, stages: stages.stages.map(({ id, name, kind, position }) => ({ id, name, kind, position })) },
    members,
    currentUserId: actor.userId,
  };
}
