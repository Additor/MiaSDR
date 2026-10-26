import type { ReactNode } from "react";
import { SummaryLine, type SummaryItem } from "@/components/shell/summary-line";
import { channelLabel, type OutreachChannelName } from "@/contexts/outreach/domain/campaign-view";
import { MetaLine, RecordHeader } from "@/app/(app)/_components/record/record-header";
import { CampaignStatusToken } from "./campaign-status-token";

/** Senders the meta line names before it counts the rest. */
const SENDERS_SHOWN = 2;

function sendersText(channel: OutreachChannelName, senders: string[]): string {
  if (senders.length === 0) return channel === "linkedin" ? "All LinkedIn accounts" : "All mailboxes";
  const shown = senders.slice(0, SENDERS_SHOWN).join(", ");
  const more = senders.length - SENDERS_SHOWN;
  return more > 0 ? `From ${shown} and ${more} more` : `From ${shown}`;
}

/**
 * The top of a campaign page in the record frame: the name as the h1 with its status token, the controls, one meta line
 * (channel, step count, senders) and the campaign's counts.
 */
export function CampaignHeader({
  name,
  status,
  archived,
  channel,
  personal = false,
  steps,
  senders,
  summary,
  actions,
}: {
  name: string;
  status: string;
  archived: boolean;
  channel: OutreachChannelName;
  personal?: boolean;
  steps: number;
  /** Labels of the assigned senders; none means every connected one sends. */
  senders: string[];
  summary: SummaryItem[];
  actions: ReactNode;
}) {
  return (
    <RecordHeader
      testId="campaign-header"
      name={name}
      state={<CampaignStatusToken status={status} archived={archived} />}
      actions={actions}
      status={
        <>
          <MetaLine
            label="Campaign facts"
            testId="campaign-facts"
            items={[
              <span key="channel">{channelLabel(channel)}</span>,
              personal && (
                <span key="personal" title="Replies stay out of the Inbox, Actions and the AI.">
                  Personal
                </span>
              ),
              <span key="steps" className="tabular-nums">
                {steps} {steps === 1 ? "step" : "steps"}
              </span>,
              <span key="senders" className="min-w-0 break-words">
                {sendersText(channel, senders)}
              </span>,
            ]}
          />
          <SummaryLine items={summary} />
        </>
      }
    />
  );
}
