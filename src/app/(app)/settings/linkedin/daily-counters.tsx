"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Button } from "@/components/ui/button";
import { callApi } from "@/lib/api-client";
import { SettingsSection } from "../settings-section";

/** Clears the pause LinkedIn set after a limit error and the search lead counter, on every account. */
export function DailyCounters() {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);

  async function reset() {
    const result = await callApi<{ accounts: number; pausesCleared: number; searchCountersCleared: number }>("/api/linkedin/jobs/reset-daily-limits", "POST");
    if (!result.ok || !result.data) throw new Error(result.error ?? "Reset failed.");
    toast.success(`Reset ${result.data.accounts} account(s): ${result.data.pausesCleared} pause(s) and ${result.data.searchCountersCleared} search counter(s) cleared.`);
    router.refresh();
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
