"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callApi } from "@/lib/api-client";
import { SettingsSection } from "../settings-section";

interface Rules {
  sendGapMinutes: [number, number];
  takeoverAfterHours: number;
}

/** The pace between sends and the takeover delay. Every mailbox follows them, so they close the Mailboxes page. */
export function SendingRulesForm({ rules, canEdit }: { rules: Rules; canEdit: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const result = await callApi("/api/settings/email-rules", "PATCH", {
      minGapMinutes: Number(data.get("min")),
      maxGapMinutes: Number(data.get("max")),
      takeoverAfterHours: Number(data.get("takeover")),
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast.success("Sending rules saved.");
    router.refresh();
  }

  return (
    <SettingsSection id="sending-rules" title="Sending rules" description="Every mailbox follows these rules. Campaigns show them on their Settings tab.">
      <form onSubmit={onSubmit} className="stack-group">
        <fieldset className="stack-field">
          <legend className="pb-field text-sm font-medium">Gap between sends (minutes)</legend>
          <p className="text-sm text-muted-foreground">Each mailbox waits a random number of minutes between the two values before its next send. Whole minutes, 1 to 240.</p>
          <div className="flex flex-wrap items-end gap-group pt-field">
            <div className="stack-field">
              <Label htmlFor="min">Shortest</Label>
              <Input id="min" name="min" type="number" min={1} max={240} step={1} defaultValue={rules.sendGapMinutes[0]} required disabled={!canEdit} className="w-28" />
            </div>
            <div className="stack-field">
              <Label htmlFor="max">Longest</Label>
              <Input id="max" name="max" type="number" min={1} max={240} step={1} defaultValue={rules.sendGapMinutes[1]} required disabled={!canEdit} className="w-28" />
            </div>
          </div>
        </fieldset>
        <div className="stack-field">
          <Label htmlFor="takeover">Takeover delay (hours)</Label>
          <Input id="takeover" name="takeover" type="number" min={1} max={168} step={1} defaultValue={rules.takeoverAfterHours} required disabled={!canEdit} className="w-28" />
          <p className="text-sm text-muted-foreground">
            Follow-ups stay on the mailbox that sent the first email. When that mailbox is disabled or failed for longer than this, another mailbox takes the follow-up over as a new thread. Whole hours, 1 to 168.
          </p>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {canEdit && (
          <div>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        )}
      </form>
    </SettingsSection>
  );
}
