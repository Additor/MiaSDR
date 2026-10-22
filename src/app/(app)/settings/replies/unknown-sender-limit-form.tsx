"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { callApi } from "@/lib/api-client";
import { SaveRow, useLeaveGuard } from "../settings-form";
import { SettingsSection } from "../settings-section";

/** The daily AI job limit for replies from senders the organization never wrote to. It is stored on the organization. */
export function UnknownSenderLimitForm({ limit, timeZone, canManage }: { limit: number; timeZone: string; canManage: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(String(limit));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const dirty = Number(value) !== limit;
  useLeaveGuard(dirty);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await callApi("/api/settings/organization", "PATCH", { unknownSenderAiDailyCap: Number(value) });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast.success("Limit saved.");
    router.refresh();
  }

  return (
    <SettingsSection title="Unknown senders" description="Replies from addresses you never wrote to use AI jobs too. This caps how many a day.">
      <form onSubmit={onSubmit}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="unknownSenderAiDailyCap">AI jobs per day</FieldLabel>
            <Input id="unknownSenderAiDailyCap" type="number" min={0} max={10000} step={1} value={value} onChange={(e) => setValue(e.target.value)} disabled={!canManage} required className="w-32" />
            <FieldDescription>
              Over the limit, jobs are skipped and listed under <Link href="/settings/jobs">Jobs</Link>. The day follows the organization&apos;s time zone, {timeZone}.
            </FieldDescription>
          </Field>
          {canManage && <SaveRow dirty={dirty} pending={pending} error={error} onDiscard={() => setValue(String(limit))} />}
        </FieldGroup>
      </form>
    </SettingsSection>
  );
}
