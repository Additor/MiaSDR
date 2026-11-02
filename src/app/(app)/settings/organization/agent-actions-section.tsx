"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { toastOrThrow, useApiAction } from "@/app/_lib/use-api-action";
import { SettingsSection } from "../settings-section";

export interface AgentActionSettings {
  agentSpendCentsPerDay: number;
  agentSearchLeadsPerDay: number;
  agentIrreversiblePerDay: number;
}

/**
 * What agents may spend and do that a person cannot undo, beside what they may send. Each limit starts at 0, which turns
 * it off. Dropping to 0 retires the tokens that used it, so raising it later needs new ones. An owner or admin changes
 * it; members see it.
 */
export function AgentActionsSection({ settings, spendInstallEnabled, irreversibleInstallEnabled, canManage }: { settings: AgentActionSettings; spendInstallEnabled: boolean; irreversibleInstallEnabled: boolean; canManage: boolean }) {
  const router = useRouter();
  const { isBusy, run } = useApiAction();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<AgentActionSettings | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const next: AgentActionSettings = {
      agentSpendCentsPerDay: Math.round(Number(data.get("spend")) * 100),
      agentSearchLeadsPerDay: Number(data.get("search")),
      agentIrreversiblePerDay: Number(data.get("irreversible")),
    };
    // Turning either on lets agents do more, and dropping to 0 retires tokens, so those ask first. Other changes save directly.
    const keys = Object.keys(next) as Array<keyof AgentActionSettings>;
    if (keys.some((key) => (next[key] === 0) !== (settings[key] === 0))) setConfirming(next);
    else void save(next);
  }

  async function save(patch: AgentActionSettings) {
    await run("save", async () => {
      setError(null);
      const result = await runApiAction(callApi("/api/settings/mcp", "PATCH", { ...patch }), { refresh: () => router.refresh() });
      if (!result.ok) return setError(result.error);
      toastOrThrow(result, "Agent limits saved.");
    });
  }

  return (
    <SettingsSection
      id="agent-actions"
      title="Agents can spend and delete"
      description="What AI agents connected over MCP may spend, and what they may do that no one can undo, in a day. 0 turns it off. Limits reset at midnight UTC. Only tokens an owner or admin creates with these options can use them."
    >
      {!spendInstallEnabled && (
        <p role="status" className="text-sm">
          This install refuses agent spending. The server administrator turns it on with the <code className="font-mono text-xs">MCP_SPEND_ENABLED</code> variable.
        </p>
      )}
      {!irreversibleInstallEnabled && (
        <p role="status" className="text-sm">
          This install refuses actions agents cannot undo. The server administrator turns them on with the <code className="font-mono text-xs">MCP_IRREVERSIBLE_ENABLED</code> variable.
        </p>
      )}
      <form onSubmit={submit}>
        <FieldGroup>
          <FieldSet disabled={!canManage}>
            <FieldLegend variant="label">Daily limits</FieldLegend>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="agent-limit-spend">Enrichment spend per day, in dollars</FieldLabel>
                <Input id="agent-limit-spend" name="spend" type="number" min={0} max={1000} step={0.01} required defaultValue={settings.agentSpendCentsPerDay / 100} />
                <FieldDescription>Counted at the prices you entered for each provider. A column with no price is refused. Credits are not counted.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="agent-limit-search">LinkedIn search results per day</FieldLabel>
                <Input id="agent-limit-search" name="search" type="number" min={0} max={5000} required defaultValue={settings.agentSearchLeadsPerDay} />
                <FieldDescription>Searches use the daily limits of your LinkedIn accounts.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="agent-limit-irreversible">Actions agents cannot undo, per day</FieldLabel>
                <Input id="agent-limit-irreversible" name="irreversible" type="number" min={0} max={200} required defaultValue={settings.agentIrreversiblePerDay} />
                <FieldDescription>Completing a campaign and deleting a lead, contact, deal or draft campaign. Deleting a contact erases its conversations.</FieldDescription>
              </Field>
            </div>
          </FieldSet>
          {error && <FieldError>{error}</FieldError>}
          {canManage && (
            <div>
              <Button type="submit" disabled={isBusy("save")}>
                {isBusy("save") ? "Saving…" : "Save"}
              </Button>
            </div>
          )}
        </FieldGroup>
      </form>
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title="Change what agents can do?"
        description="A limit above 0 lets tokens created with that option act within it, with no one reviewing first. A limit set to 0 stops those tokens on their next call, and turning it on again later needs new tokens."
        confirmLabel="Save limits"
        cancelLabel="Cancel"
        pendingLabel="Saving…"
        onConfirm={async () => {
          if (confirming) await save(confirming);
          setConfirming(null);
        }}
      />
    </SettingsSection>
  );
}
