import { isOutboundPaused } from "@/shared/outbound-pause";

export interface OutboundPauseBanner {
  paused: boolean;
  /** Text for the banner; null when sending runs. */
  text: string | null;
}

export const OUTBOUND_PAUSED_TEXT =
  "Campaign emails and LinkedIn actions wait until the pause ends. Replies you approve still send. The server administrator ends the pause, see docs/operations.md.";

/** Read model for the Jobs page and the campaign page. */
export function getOutboundPauseBanner(): OutboundPauseBanner {
  const paused = isOutboundPaused();
  return { paused, text: paused ? OUTBOUND_PAUSED_TEXT : null };
}
