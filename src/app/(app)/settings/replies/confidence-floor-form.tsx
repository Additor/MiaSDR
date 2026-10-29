"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { useApiAction } from "@/app/_lib/use-api-action";
import { SaveRow, useLeaveGuard } from "../settings-form";
import { SettingsSection } from "../settings-section";

/** The organization's confidence floor: an AI pick below it waits for a person, whatever its type's Check says. */
export function ConfidenceFloorForm({ confidenceFloor, canManage }: { confidenceFloor: number; canManage: boolean }) {
  const router = useRouter();
  const saved = String(Math.round(confidenceFloor * 1000) / 10);
  const [percent, setPercent] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const { isBusy, run } = useApiAction<"save">();
  const pending = isBusy("save");
  const dirty = Number(percent) !== Number(saved);
  useLeaveGuard(dirty);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await run("save", async () => {
      setError(null);
      return runApiAction(callApi("/api/settings/replies", "PATCH", { autoApplyConfidence: Number(percent) / 100 }), { refresh: () => router.refresh() });
    });
    if (!result) return;
    if (!result.ok) return setError(result.error);
    toast.success("Confidence floor saved.");
  }

  return (
    <SettingsSection title="Confidence floor">
      <form onSubmit={save}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="confidence-floor">Percent confidence</FieldLabel>
            <Input id="confidence-floor" type="number" min={0} max={100} step={0.1} value={percent} onChange={(e) => setPercent(e.target.value)} disabled={!canManage} className="w-32" required />
            <FieldDescription>Below this, an AI pick waits for a person.</FieldDescription>
          </Field>
          {canManage && <SaveRow dirty={dirty} pending={pending} error={error} onDiscard={() => setPercent(saved)} />}
        </FieldGroup>
      </form>
    </SettingsSection>
  );
}
