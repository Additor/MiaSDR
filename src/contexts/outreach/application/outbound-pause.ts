import { isOutboundPaused } from "@/shared/outbound-pause";
import type { SendPause } from "../domain/send-pause";

export interface OutboundPauseBanner {
  paused: boolean;
  /** Text for the banner; null when sending runs. */
  text: string | null;
  /** Where an owner or admin resumes the organization's own pause. Absent for PAUSE_OUTBOUND, which only the server ends. */
  href?: string;
}

export const OUTBOUND_PAUSED_TEXT =
  "Campaign emails and LinkedIn actions wait until the pause ends. Replies you approve still send. The server administrator ends the pause, see docs/operations.md.";

export const ORGANIZATION_PAUSE_HREF = "/settings/organization#sending";

const organizationPausedText = (pause: SendPause) =>
  `${pause.byName ?? "An owner or admin"} paused campaign emails and LinkedIn actions for this organization. Replies you approve still send.`;

/** Read model for the app shell. The server-wide PAUSE_OUTBOUND wins over the organization's own pause. */
export function getOutboundPauseBanner(organizationPause: SendPause | null = null): OutboundPauseBanner {
  if (isOutboundPaused()) return { paused: true, text: OUTBOUND_PAUSED_TEXT };
  if (organizationPause) return { paused: true, text: organizationPausedText(organizationPause), href: ORGANIZATION_PAUSE_HREF };
  return { paused: false, text: null };
}
