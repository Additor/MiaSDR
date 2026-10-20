import { ViewSwitch } from "@/components/shell/view-switch";
import { CAMPAIGN_TABS, CAMPAIGN_TAB_LABELS, campaignTabHref, type CampaignTab } from "@/contexts/outreach/domain/campaign-view";

/** Leads, Sequence and Settings of a campaign. Each tab has its own URL (`?tab=`), so a Start blocker can link to the one that fixes it. */
export function CampaignTabs({ base, active }: { base: string; active: CampaignTab }) {
  return (
    <ViewSwitch
      label="Campaign sections"
      items={CAMPAIGN_TABS.map((tab) => ({ href: campaignTabHref(base, tab), label: CAMPAIGN_TAB_LABELS[tab], active: active === tab, testId: `campaign-tab-${tab}` }))}
    />
  );
}

/** The line above the steps editor. The steps are the campaign's own messages, so the note says when they stop. */
export function SequenceNote() {
  return <p className="text-sm text-muted-foreground">These messages send automatically at their time. A reply, bounce or unsubscribe stops them.</p>;
}
