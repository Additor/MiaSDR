"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callApi } from "@/lib/api-client";
import { SettingsSection } from "../settings-section";

/** The daily AI job limit for replies from senders the organization never wrote to. It is stored on the organization. */
export function UnknownSenderLimitForm({ limit, timeZone, canManage }: { limit: number; timeZone: string; canManage: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const result = await callApi("/api/settings/organization", "PATCH", { unknownSenderAiDailyCap: Number(data.get("unknownSenderAiDailyCap")) });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast.success("Limit saved.");
    router.refresh();
  }

  return (
    <SettingsSection
      title="Unknown senders"
      description={
        <>
          Replies from addresses you never wrote to use AI jobs too. Over the limit, jobs are skipped and listed under{" "}
          <Link href="/settings/jobs" className="underline underline-offset-4">
            Jobs
          </Link>
          . The day follows the organization&apos;s time zone, {timeZone}.
        </>
      }
    >
      <form onSubmit={onSubmit} className="stack-group">
        <div className="stack-field">
          <Label htmlFor="unknownSenderAiDailyCap">AI jobs per day</Label>
          <Input id="unknownSenderAiDailyCap" name="unknownSenderAiDailyCap" type="number" min={0} max={10000} step={1} defaultValue={limit} disabled={!canManage} required className="w-32" />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {canManage && (
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
