"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Button } from "@/components/ui/button";
import { orThrow, runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { countOf } from "@/shared/format-number";
import { SettingsSection } from "../settings-section";

/** Clears the pause LinkedIn set after a limit error and the search lead counter, on every account. */
export function DailyCounters() {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);

  async function reset() {
    const data = orThrow(
      await runApiAction(callApi<{ accounts: number; pausesCleared: number; searchCountersCleared: number }>("/api/linkedin/jobs/reset-daily-limits", "POST"), { refresh: () => router.refresh(), expectData: true }),
    );
    toast.success(`Reset ${countOf(data.accounts, "account")}: ${countOf(data.pausesCleared, "pause")} and ${countOf(data.searchCountersCleared, "search counter")} cleared.`);
  }

  return (
    <SettingsSection
      title="Daily counters"
      description="Clears the pause LinkedIn set after a limit error and the search lead counter, on every account. Invitation and message counts stay, so the daily caps keep protecting the accounts. Jobs > History lists the reset with your name."
    >
      <div>
        <Button variant="outline" onClick={() => setConfirming(true)}>
          Reset daily counters
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Reset daily counters?"
        description="Clears the LinkedIn rate-limit pause and the search counter on every account. Invitation and message counts stay."
        confirmLabel="Reset counters"
        pendingLabel="Resetting…"
        onConfirm={reset}
      />
    </SettingsSection>
  );
}
