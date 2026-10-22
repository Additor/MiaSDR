"use client";

import { PauseCircleIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Time } from "@/components/shell/time";
import { Button } from "@/components/ui/button";
import { callApi } from "@/lib/api-client";
import { SettingsSection } from "../settings-section";

interface Pause {
  at: string;
  byName: string | null;
}

/** The organization's own stop switch for campaign emails and LinkedIn actions. Approved replies keep sending. */
export function SendPauseSection({ pause, canManage }: { pause: Pause | null; canManage: boolean }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);

  async function change(paused: boolean) {
    const result = await callApi("/api/settings/sending-pause", "PUT", { paused });
    if (!result.ok) throw new Error(result.error ?? "Could not change the pause.");
    toast.success(paused ? "Sending paused." : "Sending resumed.");
    router.refresh();
  }

  return (
    <SettingsSection
      id="sending"
      title="Sending"
      description="Pause stops every campaign email and LinkedIn action of this organization at once. Replies a person approves still send, and nothing in a campaign changes, so resuming picks up where it stopped."
    >
      {pause ? (
        // A degraded state: the warning hue on the icon and the lead words only.
        <p role="status" className="flex items-start gap-2 text-sm">
          <PauseCircleIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            <strong className="font-medium text-warning">Sending is paused.</strong> {pause.byName ?? "An owner or admin"} paused it <Time value={pause.at} />.
          </span>
        </p>
      ) : (
        <p className="text-sm">Campaign emails and LinkedIn actions send within each mailbox&apos;s and account&apos;s limits and hours.</p>
      )}
      {canManage && (
        <div>
          <Button variant="outline" onClick={() => setConfirming(true)}>
            {pause ? "Resume sending" : "Pause all sending"}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={pause ? "Resume sending?" : "Pause all sending?"}
        description={
          pause
            ? "Campaigns pick up where they stopped. Steps that came due during the pause send at the next slot inside each mailbox's working hours and daily limit."
            : "Campaign emails and LinkedIn actions stop for everyone in this organization until an owner or admin resumes them. A banner says so on every page."
        }
        confirmLabel={pause ? "Resume sending" : "Pause sending"}
        cancelLabel={pause ? "Keep paused" : "Keep sending"}
        pendingLabel={pause ? "Resuming…" : "Pausing…"}
        onConfirm={() => change(!pause)}
      />
    </SettingsSection>
  );
}
