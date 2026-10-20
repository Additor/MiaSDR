import type { DealStageKind } from "./stages";

/**
 * The deal that stands for a person where one deal shows: the contact page's Open deal, the Inbox thread's Open deal and
 * the Contacts list's Latest deal column. An open deal comes first, then the newest by creation, then the higher id, so
 * the pick does not flip. `crm-read`'s `latestDealJoin` orders the same way in SQL.
 */
export function primaryDeal<T extends { id: string; stageKind: DealStageKind; createdAt: Date }>(deals: readonly T[]): T | null {
  return (
    [...deals].sort(
      (a, b) => Number(b.stageKind === "open") - Number(a.stageKind === "open") || b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
    )[0] ?? null
  );
}
