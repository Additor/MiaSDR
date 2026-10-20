import { excludedNoticesForCampaign } from "@/contexts/outreach/application/cross-campaign-notices";
import { crossCampaignNotices } from "@/contexts/outreach/infrastructure/composition";
import type { Actor } from "@/shared/errors";
import { CampaignSection } from "./campaign-section";
import { CrossCampaignNoticeList } from "./cross-campaign-notices";

/** Leads of this campaign skipped because the sending account already invited them elsewhere. Renders nothing when there are none. */
export async function CrossCampaignSkipped({ actor, campaignId }: { actor: Actor; campaignId: string }) {
  const excluded = await excludedNoticesForCampaign(crossCampaignNotices, actor, campaignId);
  if (excluded.excludedByAccountPeople === 0) return null;
  return (
    <CampaignSection
      level="h3"
      testId="cross-campaign-skipped"
      className="last:pb-0"
      title="Skipped because the account already invited them"
      description="A LinkedIn account does not invite the same person twice. These leads stay in the list as Stopped, with the reason in their status."
    >
      <CrossCampaignNoticeList notices={{ ...excluded, alreadyContacted: [], alreadyContactedPeople: 0 }} />
    </CampaignSection>
  );
}
