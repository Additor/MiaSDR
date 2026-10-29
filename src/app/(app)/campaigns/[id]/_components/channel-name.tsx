import { MailIcon } from "lucide-react";
import { channelLabel, type OutreachChannelName } from "@/contexts/outreach/domain/campaign-view";
import { LinkedInMark } from "@/app/(app)/_components/person/reach-icons";

/**
 * A campaign's channel as a plain descriptor: its icon and its name in muted text, the same on the Campaigns list and in
 * the campaign's meta line. It is a fact about the campaign, not a state, so it takes no badge.
 */
export function ChannelName({ channel }: { channel: OutreachChannelName }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0" data-testid="campaign-channel">
      {channel === "linkedin" ? <LinkedInMark /> : <MailIcon aria-hidden />}
      {channelLabel(channel)}
    </span>
  );
}
