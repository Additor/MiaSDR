"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { unsavedNames, useUnsavedEdits } from "./unsaved-edits";
import { ViewSwitch } from "@/components/shell/view-switch";
import { CAMPAIGN_TABS, CAMPAIGN_TAB_LABELS, campaignTabHref, type CampaignTab } from "@/contexts/outreach/domain/campaign-view";

/** Leads, Sequence and Settings of a campaign. Each tab has its own URL (`?tab=`), so a Start blocker can link to the one that fixes it. */
export function CampaignTabs({ base, active, campaignId }: { base: string; active: CampaignTab; campaignId: string }) {
  return (
    <>
    <LeaveWithUnsaved campaignId={campaignId} />
    <ViewSwitch
      label="Campaign sections"
      items={CAMPAIGN_TABS.map((tab) => ({ href: campaignTabHref(base, tab), label: CAMPAIGN_TAB_LABELS[tab], active: active === tab, testId: `campaign-tab-${tab}` }))}
    />
    </>
  );
}

/**
 * A link inside the app unmounts the campaign's editors, and `beforeunload` does not see it. While an editor holds edits, a
 * click on any link asks first. The Start blockers, the tabs and the sidebar all pass through here.
 */
function LeaveWithUnsaved({ campaignId }: { campaignId: string }) {
  const router = useRouter();
  const unsaved = useUnsavedEdits(campaignId);
  const [target, setTarget] = useState<string | null>(null);
  const holding = unsaved.length > 0;
  useEffect(() => {
    if (!holding) return;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest?.("a[href]");
      if (!(link instanceof HTMLAnchorElement) || link.target === "_blank" || link.origin !== window.location.origin) return;
      if (link.pathname === window.location.pathname && link.search === window.location.search) return;
      event.preventDefault();
      event.stopPropagation();
      setTarget(`${link.pathname}${link.search}${link.hash}`);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [holding]);
  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={(open) => !open && setTarget(null)}
      title="Leave without saving?"
      description={`${unsavedNames(unsaved)} ${unsaved.length > 1 ? "have" : "has"} unsaved changes. They are lost when you leave.`}
      confirmLabel="Leave"
      cancelLabel="Keep editing"
      destructive
      onConfirm={async () => {
        if (target) router.push(target);
      }}
    />
  );
}

/** The line above the steps editor. The steps are the campaign's own messages, so the note says when they stop. */
export function SequenceNote() {
  return <p className="text-sm text-muted-foreground">These messages send automatically at their time. A reply, bounce or unsubscribe stops them.</p>;
}
