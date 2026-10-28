import { listDealStages } from "@/contexts/deals/application/deal-stages";
import { dealsDeps } from "@/composition/deals";
import type { Actor } from "@/shared/errors";
import type { DealMemberOption, DealStageList } from "./deal-form";
import { listMemberChoices } from "@/contexts/tenancy/application/member-directory";
import { memberDirectoryDeps } from "@/contexts/tenancy/infrastructure/member-composition";

/**
 * What the deal dialogs need from the server: the stages and the owner choices (the organization's members, the same
 * list the tasks panel assigns from). Call it from a server component that already awaited `connection()`.
 */
export async function dealDialogData(actor: Actor): Promise<{ stages: DealStageList; members: DealMemberOption[]; currentUserId: string }> {
  const [stages, members] = await Promise.all([listDealStages(dealsDeps(), actor), listMemberChoices(memberDirectoryDeps(), actor)]);
  return {
    stages: { virtual: stages.virtual, stages: stages.stages.map(({ id, name, kind, position }) => ({ id, name, kind, position })) },
    members,
    currentUserId: actor.userId,
  };
}
