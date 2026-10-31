"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { toastOrThrow, useApiAction } from "@/app/_lib/use-api-action";
import { SettingsSection } from "../settings-section";

type Mode = "off" | "replies" | "replies_and_campaigns";

export interface AgentSendSettings {
  agentSendMode: Mode;
  agentReplyCaps: { org: number; user: number; mailbox: number };
  agentEnrollCap: number;
}

const MODES: Array<{ value: Mode; label: string; description: string }> = [
  { value: "off", label: "Off", description: "Agents write drafts and make changes. A person sends every reply and starts every campaign." },
  { value: "replies", label: "Replies", description: "Agents with a send token reply in conversations a campaign or a person already started." },
  { value: "replies_and_campaigns", label: "Replies and campaigns", description: "Agents also start and resume campaigns and enroll leads in active ones." },
];

const LIMITS = [
  { key: "org", label: "Agent replies per day, whole organization" },
  { key: "user", label: "Agent replies per day, one person's tokens" },
  { key: "mailbox", label: "Agent email replies per day, one mailbox" },
] as const;

/**
 * Whether agents send, beside the Sending pause: the mode and the daily limits. Turning it off retires every send token,
 * so turning it on later needs new ones. An owner or admin changes it; members see it.
 */
export function AgentSendSection({ settings, installEnabled, canManage }: { settings: AgentSendSettings; installEnabled: boolean; canManage: boolean }) {
  const router = useRouter();
  const { isBusy, run } = useApiAction();
  const [mode, setMode] = useState<Mode>(settings.agentSendMode);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Record<string, unknown> | null>(null);
  const editable = canManage && installEnabled;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const whole = (name: string) => Number(data.get(name));
    const patch = {
      agentSendMode: mode,
      agentReplyCaps: { org: whole("org"), user: whole("user"), mailbox: whole("mailbox") },
      agentEnrollCap: whole("enroll"),
    };
    // A mode change reaches every agent at once, so it asks first. Limits alone save directly.
    if (mode !== settings.agentSendMode) setConfirming(patch);
    else void save(patch);
  }

  async function save(patch: Record<string, unknown>) {
    await run("save", async () => {
      setError(null);
      const result = await runApiAction(callApi("/api/settings/mcp", "PATCH", patch), { refresh: () => router.refresh() });
      if (!result.ok) return setError(result.error);
      toastOrThrow(result, "Agent sending saved.");
    });
  }

  return (
    <SettingsSection
      id="agent-sending"
      title="Agents can send"
      description="What AI agents connected over MCP may send without a person reviewing it first, and how much in a day. Limits reset at midnight UTC. The Sending pause stops agents too."
    >
      {!installEnabled && (
        <p role="status" className="text-sm">
          This install refuses every agent send. The server administrator turns it on with the <code className="font-mono text-xs">MCP_SEND_ENABLED</code> variable.
        </p>
      )}
      <form onSubmit={submit}>
        <FieldGroup>
          <FieldSet disabled={!editable}>
            <FieldLegend variant="label" id="agent-send-mode-legend">
              Agents may send
            </FieldLegend>
            <RadioGroup aria-labelledby="agent-send-mode-legend" value={mode} onValueChange={(v) => setMode(v as Mode)}>
              {MODES.map((m) => (
                <Field key={m.value} orientation="horizontal">
                  <RadioGroupItem value={m.value} id={`agent-send-${m.value}`} disabled={!editable} />
                  <div>
                    <FieldLabel htmlFor={`agent-send-${m.value}`}>{m.label}</FieldLabel>
                    <FieldDescription>{m.description}</FieldDescription>
                  </div>
                </Field>
              ))}
            </RadioGroup>
          </FieldSet>
          <FieldSet disabled={!editable}>
            <FieldLegend variant="label">Daily limits</FieldLegend>
            <div className="grid gap-4 sm:grid-cols-2">
              {LIMITS.map((limit) => (
                <Field key={limit.key}>
                  <FieldLabel htmlFor={`agent-cap-${limit.key}`}>{limit.label}</FieldLabel>
                  <Input id={`agent-cap-${limit.key}`} name={limit.key} type="number" min={0} max={1000} required defaultValue={settings.agentReplyCaps[limit.key]} />
                </Field>
              ))}
              <Field>
                <FieldLabel htmlFor="agent-cap-enroll">Leads agents enroll per day, both channels</FieldLabel>
                <Input id="agent-cap-enroll" name="enroll" type="number" min={0} max={5000} required defaultValue={settings.agentEnrollCap} />
              </Field>
            </div>
          </FieldSet>
          {error && <FieldError>{error}</FieldError>}
          {editable && (
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
        title={mode === "off" ? "Stop agents from sending?" : "Let agents send?"}
        description={
          mode === "off"
            ? "Every token that sends stops sending on its next call. Turning agent sending on again later needs new tokens."
            : "Members and admins can then create tokens whose agents send to leads from their mailboxes and LinkedIn accounts with no one reviewing first, within the limits above."
        }
        confirmLabel={mode === "off" ? "Stop agent sending" : "Let agents send"}
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
