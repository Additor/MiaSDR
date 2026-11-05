"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { toastOrThrow, useApiAction } from "@/app/_lib/use-api-action";
import { BACKGROUND_SHARE, MAX_DAILY_TOKENS } from "@/contexts/mia/domain/mia-settings";
import { SettingsSection } from "../settings-section";

/** Whether Mia runs here and how many tokens of your AI provider it may use. An owner or admin changes it; members see it. */
export function MiaSection({ settings, usedToday, installEnabled, canManage }: { settings: { enabled: boolean; dailyTokenLimit: number }; usedToday: number; installEnabled: boolean; canManage: boolean }) {
  const router = useRouter();
  const { isBusy, run } = useApiAction();
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(settings.enabled);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const dailyTokenLimit = Number(new FormData(event.currentTarget).get("limit"));
    void run("save", async () => {
      setError(null);
      const result = await runApiAction(callApi("/api/settings/mia", "PATCH", { enabled, dailyTokenLimit }), { refresh: () => router.refresh() });
      if (!result.ok) return setError(result.error);
      toastOrThrow(result, "Mia settings saved.");
    });
  }

  return (
    <SettingsSection id="mia" title="Mia" description="Mia suggests Brain items from your website or text, using your AI provider. Each person starts each job, and nothing reaches Brain until someone reviews it.">
      {!installEnabled && (
        <p role="status" className="text-sm">
          This install turns Mia off. The server administrator turns it on with the <code className="font-mono text-xs">MIA_ENABLED</code> variable.
        </p>
      )}
      <form onSubmit={submit}>
        <FieldSet disabled={!canManage}>
          <FieldGroup>
            <Field orientation="horizontal">
              <Checkbox id="mia-enabled" checked={enabled} onCheckedChange={(checked) => setEnabled(checked === true)} />
              <FieldLabel htmlFor="mia-enabled">Mia is on</FieldLabel>
            </Field>
            <Field>
              <FieldLabel htmlFor="mia-limit">Tokens per day</FieldLabel>
              <Input id="mia-limit" name="limit" type="number" min={0} max={MAX_DAILY_TOKENS} step={1} required defaultValue={settings.dailyTokenLimit} />
              <FieldDescription>
                {usedToday.toLocaleString("en-US")} used today. Jobs stop at {Math.round(BACKGROUND_SHARE * 100)}% of this and continue after midnight UTC.
              </FieldDescription>
            </Field>
            {error && <FieldError>{error}</FieldError>}
            {canManage && (
              <div>
                <Button type="submit" variant="outline" disabled={isBusy("save")}>
                  {isBusy("save") ? "Saving…" : "Save"}
                </Button>
              </div>
            )}
          </FieldGroup>
        </FieldSet>
      </form>
    </SettingsSection>
  );
}
