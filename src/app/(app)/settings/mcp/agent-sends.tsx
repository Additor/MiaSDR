"use client";

import { TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { EmptyState } from "@/components/shell/empty-state";
import { Time } from "@/components/shell/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { toastOrThrow } from "@/app/_lib/use-api-action";
import { RULED_LIST, RULED_ROW, SettingsSection } from "../settings-section";

export interface AgentSendsData {
  sends: Array<{ attemptId: string; threadId: string; channel: "email" | "linkedin"; status: string; tokenName: string; userName: string; createdAt: string }>;
  campaigns: Array<{ campaignId: string; name: string; channel: string; status: string; tokenName: string; enrolledByAgents: number }>;
  running: number;
  today: { replies: number; enrolls: number; busiestUser: number; busiestMailbox: number };
  limits: { replies: number; enrolls: number; user: number; mailbox: number };
}

const STATUS_LABEL: Record<string, string> = {
  sending: "Sending",
  sent: "Sent",
  reconciled: "Sent",
  failed: "Not sent",
  delivery_uncertain: "Unconfirmed",
};

/**
 * What agents sent and started, for owners and admins: the day's counts against the limits, recent agent replies, and
 * the campaigns agents started, with one button that pauses all of those at once.
 */
export function AgentSends({ data }: { data: AgentSendsData }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const { running } = data;
  const repliesFull = data.today.replies >= data.limits.replies;
  // One person or mailbox can reach its own limit while the organization has room, so those replies wait too.
  const someReplies = !repliesFull && (data.today.busiestUser >= data.limits.user || data.today.busiestMailbox >= data.limits.mailbox);
  const enrollsFull = data.today.enrolls >= data.limits.enrolls;
  const replies = repliesFull ? "Agent replies" : someReplies ? "Some agent replies" : null;
  const waiting = replies && enrollsFull ? `${replies} and enrolls wait` : replies ? `${replies} wait` : "Agent enrolls wait";

  return (
    <SettingsSection
      id="agent-sends"
      title="Agent sends"
      description="Replies agents sent and campaigns they started. Today counts from midnight UTC; Settings, Organization sets the limits."
      action={
        running > 0 ? (
          <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
            Pause campaigns agents started
          </Button>
        ) : undefined
      }
    >
      <p className="text-sm">
        Today: {data.today.replies} of {data.limits.replies} agent replies, {data.today.enrolls} of {data.limits.enrolls} leads enrolled by agents.
      </p>
      {(repliesFull || someReplies || enrollsFull) && (
        <p role="status" className="flex items-start gap-2 text-sm">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            <strong className="font-medium text-warning">Agents reached today&apos;s limit.</strong> {waiting} until midnight UTC unless you raise the limit.
          </span>
        </p>
      )}
      {data.sends.length === 0 ? (
        <EmptyState className="py-0" title="No agent replies yet" />
      ) : (
        <ul className={RULED_LIST} aria-label="Agent replies">
          {data.sends.map((send) => (
            <li key={send.attemptId} className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-sm ${RULED_ROW}`}>
              <span className="font-medium">{send.channel === "linkedin" ? "LinkedIn reply" : "Email reply"}</span>
              <Badge variant={send.status === "delivery_uncertain" || send.status === "failed" ? "outline" : "secondary"}>{STATUS_LABEL[send.status] ?? send.status}</Badge>
              <span className="text-muted-foreground">
                {send.userName}, {send.tokenName}
              </span>
              <Link href={`/inbox/${send.threadId}`} className="underline underline-offset-2">
                Conversation
              </Link>
              <Time value={send.createdAt} className="ml-auto text-muted-foreground" />
            </li>
          ))}
        </ul>
      )}
      {data.campaigns.length > 0 && (
        <ul className={RULED_LIST} aria-label="Campaigns agents started">
          {data.campaigns.map((campaign) => (
            <li key={campaign.campaignId} className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-sm ${RULED_ROW}`}>
              <Link href={`/campaigns/${campaign.campaignId}`} className="font-medium underline underline-offset-2">
                {campaign.name}
              </Link>
              <Badge variant="secondary">{campaign.status === "active" ? "Running" : campaign.status.charAt(0).toUpperCase() + campaign.status.slice(1)}</Badge>
              <span className="text-muted-foreground">
                started with {campaign.tokenName}, {campaign.enrolledByAgents} lead{campaign.enrolledByAgents === 1 ? "" : "s"} added by agents
              </span>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Pause the campaigns agents started?"
        description={`${running} campaign${running === 1 ? "" : "s"} agents started or paused stay${running === 1 ? "s" : ""} stopped until a person resumes ${running === 1 ? "it" : "them"}. Nothing else changes.`}
        confirmLabel="Pause campaigns"
        cancelLabel="Keep running"
        pendingLabel="Pausing…"
        onConfirm={async () => {
          const result = await runApiAction(callApi<{ paused: number }>("/api/settings/mcp/pause-agent-campaigns", "POST"), { refresh: () => router.refresh(), expectData: true });
          toastOrThrow(result, result.ok ? `Paused ${result.data.paused} campaign${result.data.paused === 1 ? "" : "s"}.` : "");
        }}
      />
    </SettingsSection>
  );
}
