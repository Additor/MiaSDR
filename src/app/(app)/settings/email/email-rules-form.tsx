"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callApi } from "@/lib/api-client";
import { AdminNotice } from "../admin-notice";
import { SettingsSection } from "../settings-section";

interface Rules {
  sendGapMinutes: [number, number];
  takeoverAfterHours: number;
  timeZone: string;
}

export function EmailRulesForm({ rules, canEdit }: { rules: Rules; canEdit: boolean }) {
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
      // The organization time zone is edited under Organization; this endpoint still expects the current value.
      timeZone: rules.timeZone,
      takeoverAfterHours: Number(data.get("takeover")),
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast.success("Email rules saved.");
    router.refresh();
  }

  return (
    <SettingsSection title="Sending pace" description="Each mailbox waits a random number of minutes between the two values before its next send. Whole minutes, 1 to 240.">
      <form onSubmit={onSubmit} className="stack-group">
        <div className="grid gap-group sm:grid-cols-2">
          <div className="stack-field">
            <Label htmlFor="min">Shortest gap (minutes)</Label>
            <Input id="min" name="min" type="number" min={1} max={240} step={1} defaultValue={rules.sendGapMinutes[0]} required disabled={!canEdit} />
          </div>
          <div className="stack-field">
            <Label htmlFor="max">Longest gap (minutes)</Label>
            <Input id="max" name="max" type="number" min={1} max={240} step={1} defaultValue={rules.sendGapMinutes[1]} required disabled={!canEdit} />
          </div>
          <div className="stack-field sm:col-span-2">
            <Label htmlFor="takeover">Takeover delay (hours)</Label>
            <Input id="takeover" name="takeover" type="number" min={1} max={168} step={1} defaultValue={rules.takeoverAfterHours} required disabled={!canEdit} className="w-28" />
            <p className="text-sm text-muted-foreground">
              Follow-ups stay on the mailbox that sent the first email. When that mailbox is disabled or failed for longer than this, another mailbox takes the follow-up over as a new thread. Whole hours, 1 to 168.
            </p>
          </div>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {canEdit ? (
          <div>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        ) : (
          <AdminNotice action="change these rules" />
        )}
      </form>
    </SettingsSection>
  );
}
