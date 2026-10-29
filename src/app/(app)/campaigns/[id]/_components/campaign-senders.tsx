"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { toastResult, useApiAction } from "@/app/_lib/use-api-action";
import { SenderPicker, type SenderOption } from "../../sender-picker";
import { CampaignSection } from "./campaign-section";

/** Settings section: which mailboxes or LinkedIn accounts send for this campaign. */
export function CampaignSenders({ id, channel, options, assigned }: { id: string; channel: "email" | "linkedin"; options: SenderOption[]; assigned: string[] }) {
  const router = useRouter();
  const noun = channel === "linkedin" ? "LinkedIn account" : "mailbox";
  const [value, setValue] = useState(assigned);
  const { isBusy, run } = useApiAction<"save">();
  const pending = isBusy("save");
  const dirty = value.length !== assigned.length || value.some((v) => !assigned.includes(v));

  const save = () =>
    run("save", async () => {
      const result = await runApiAction(callApi(`${channel === "linkedin" ? "/api/linkedin" : "/api"}/campaigns/${id}`, "PATCH", { senderIds: value }), { refresh: () => router.refresh() });
      toastResult(result, value.length === 0 ? `Sending from every connected ${noun}.` : "Senders saved.");
    });

  return (
    <CampaignSection
      title="Senders"
      testId="campaign-senders"
      description={
        channel === "linkedin"
          ? "Pick the LinkedIn accounts that look up profiles and send invitations for this campaign. Leads already tied to an account stay with it."
          : "Pick the mailboxes that send for this campaign. A lead tied to a mailbox you leave out moves to a ticked one, and its next email starts a new thread."
      }
    >
      <SenderPicker options={options} value={value} onChange={setValue} noun={noun} disabled={pending} />
      <div>
        <Button size="sm" onClick={() => void save()} disabled={!dirty || pending}>
          {pending ? "Saving…" : "Save senders"}
        </Button>
      </div>
    </CampaignSection>
  );
}
