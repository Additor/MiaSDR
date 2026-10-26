"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { callApi } from "@/app/_lib/api-client";
import { SaveRow, useLeaveGuard } from "../settings-form";
import { SettingsSection } from "../settings-section";

interface Settings {
  autoApplyConfidence: number;
  reviewOther: boolean;
  customerRequiresReview: boolean;
}

export function ThresholdsForm({ settings, canManage }: { settings: Settings; canManage: boolean }) {
  const router = useRouter();
  const saved = { percent: String(Math.round(settings.autoApplyConfidence * 1000) / 10), reviewOther: settings.reviewOther, customer: settings.customerRequiresReview };
  const [values, setValues] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const dirty = Number(values.percent) !== Number(saved.percent) || values.reviewOther !== saved.reviewOther || values.customer !== saved.customer;
  useLeaveGuard(dirty);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await callApi("/api/settings/replies", "PATCH", { autoApplyConfidence: Number(values.percent) / 100, reviewOther: values.reviewOther, customerRequiresReview: values.customer });
    setPending(false);
    if (!result.ok) return setError(result.error);
    toast.success("Auto-apply rules saved.");
    router.refresh();
  }

  return (
    <SettingsSection title="Auto-apply rules" description="The AI applies a classification alone only when none of these rules hold it back. A held suggestion waits for a person. Replies are never sent without approval.">
      <form onSubmit={save}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="threshold">Auto-apply at or above (percent confidence)</FieldLabel>
            <Input id="threshold" type="number" min={0} max={100} step={0.1} value={values.percent} onChange={(e) => setValues({ ...values, percent: e.target.value })} disabled={!canManage} className="w-32" required />
            <FieldDescription>Below this, the AI only suggests and a person decides.</FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <Checkbox id="review-other" checked={values.reviewOther} onCheckedChange={(c) => setValues({ ...values, reviewOther: c === true })} disabled={!canManage} />
            <FieldLabel htmlFor="review-other">Always review the category Other</FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <Checkbox id="review-customer" checked={values.customer} onCheckedChange={(c) => setValues({ ...values, customer: c === true })} disabled={!canManage} />
            <FieldLabel htmlFor="review-customer">Always review a move to Existing customer</FieldLabel>
          </Field>
          {canManage && <SaveRow dirty={dirty} pending={pending} error={error} onDiscard={() => setValues(saved)} />}
        </FieldGroup>
      </form>
    </SettingsSection>
  );
}
