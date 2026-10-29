"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { useApiAction } from "@/app/_lib/use-api-action";
import { SaveRow, useLeaveGuard } from "../settings-form";
import { SettingsSection } from "../settings-section";

interface Rules {
  sendGapMinutes: [number, number];
  takeoverAfterHours: number;
}

/** The pace between sends and the takeover delay. Every mailbox follows them, so they close the Mailboxes page. */
export function SendingRulesForm({ rules, canEdit }: { rules: Rules; canEdit: boolean }) {
  const router = useRouter();
  const saved = { min: String(rules.sendGapMinutes[0]), max: String(rules.sendGapMinutes[1]), takeover: String(rules.takeoverAfterHours) };
  const [values, setValues] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const { isBusy, run } = useApiAction<"save">();
  const pending = isBusy("save");
  const dirty = Number(values.min) !== rules.sendGapMinutes[0] || Number(values.max) !== rules.sendGapMinutes[1] || Number(values.takeover) !== rules.takeoverAfterHours;
  useLeaveGuard(dirty);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await run("save", async () => {
      setError(null);
      return runApiAction(callApi("/api/settings/email-rules", "PATCH", { minGapMinutes: Number(values.min), maxGapMinutes: Number(values.max), takeoverAfterHours: Number(values.takeover) }), { refresh: () => router.refresh() });
    });
    if (!result) return;
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast.success("Sending rules saved.");
  }

  return (
    <SettingsSection id="sending-rules" title="Sending rules" description="Every mailbox follows these rules. Campaigns show them on their Settings tab.">
      <form onSubmit={onSubmit}>
        <FieldGroup>
          <FieldSet>
            <FieldLegend variant="label">Gap between sends (minutes)</FieldLegend>
            <FieldDescription>Each mailbox waits a random number of minutes between the two values before its next send. Whole minutes, 1 to 240.</FieldDescription>
            <div className="flex flex-wrap items-end gap-group">
              <Field className="w-auto">
                <FieldLabel htmlFor="min">Shortest</FieldLabel>
                <Input id="min" type="number" min={1} max={240} step={1} value={values.min} onChange={(e) => setValues({ ...values, min: e.target.value })} required disabled={!canEdit} className="w-28" />
              </Field>
              <Field className="w-auto">
                <FieldLabel htmlFor="max">Longest</FieldLabel>
                <Input id="max" type="number" min={1} max={240} step={1} value={values.max} onChange={(e) => setValues({ ...values, max: e.target.value })} required disabled={!canEdit} className="w-28" />
              </Field>
            </div>
          </FieldSet>
          <Field>
            <FieldLabel htmlFor="takeover">Takeover delay (hours)</FieldLabel>
            <Input id="takeover" type="number" min={1} max={168} step={1} value={values.takeover} onChange={(e) => setValues({ ...values, takeover: e.target.value })} required disabled={!canEdit} className="w-28" />
            <FieldDescription>
              Follow-ups stay on the mailbox that sent the first email. When that mailbox is disabled or failed for longer than this, another mailbox takes the follow-up over as a new thread. Whole hours, 1 to 168.
            </FieldDescription>
          </Field>
          {canEdit && <SaveRow dirty={dirty} pending={pending} error={error} onDiscard={() => setValues(saved)} />}
        </FieldGroup>
      </form>
    </SettingsSection>
  );
}
