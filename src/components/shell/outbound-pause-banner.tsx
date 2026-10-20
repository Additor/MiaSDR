import { PauseCircleIcon } from "lucide-react";
import type { OutboundPauseBanner as Banner } from "@/contexts/outreach/application/outbound-pause";

/** One line across the top of every page while `PAUSE_OUTBOUND` is set, so nobody wonders why a campaign is quiet. Renders nothing otherwise. */
export function OutboundPauseBanner({ banner }: { banner: Banner }) {
  if (!banner.paused || !banner.text) return null;
  return (
    // A degraded state: the warning hue on the icon and the lead words only, never a tinted band.
    <div role="status" data-testid="outbound-pause-banner" className="flex items-start gap-2 border-b px-gutter py-2 text-sm">
      <PauseCircleIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
      <p>
        <strong className="font-medium text-warning">Sending is paused.</strong> {banner.text}
      </p>
    </div>
  );
}
