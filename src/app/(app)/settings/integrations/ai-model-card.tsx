"use client";

import { CircleAlertIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AiStatus } from "@/contexts/integrations/domain/ai-status";
import { callApi } from "@/app/_lib/api-client";
import { SettingsSection } from "../settings-section";
import { ModelCombobox } from "./model-combobox";

interface ModelView {
  status: AiStatus;
  connected: boolean;
  connections: Array<{ key: string; label: string }>;
  active: string | null;
  connection: string | null;
  model: string | null;
  effective: string | null;
  defaultModel: string | null;
  choices: string[];
  live: boolean;
  keyRejected: boolean;
  notice: string | null;
}

const DEFAULT_VALUE = "__default__";

/** The select's starting value: the saved model, else "Default" where one exists, else nothing so the placeholder shows. */
const initialChoice = (view: ModelView): string | null => view.model ?? (view.defaultModel != null ? DEFAULT_VALUE : null);

/** One line on what AI runs on now, whichever provider the picker shows. Off reads in the warning hue, as DESIGN.md asks for a degraded state. */
function RunningLine({ status, canPick = true }: { status: AiStatus; canPick?: boolean }) {
  if (status.state === "on") {
    return (
      <p role="status" className="text-sm">
        AI runs on <span className="font-medium">{status.provider}</span>, <span className="font-medium">{status.model}</span>.
      </p>
    );
  }
  if (status.state === "demo") {
    return (
      <p role="status" className="text-sm">
        Demo mode: AI answers come from stand-ins, and no provider is called. Saved keys and the model apply once AI_PROVIDER=fake is removed.
      </p>
    );
  }
  if (status.state === "no_model") {
    return (
      <p role="status" className="flex items-start gap-2 text-sm">
        <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
        <span>
          <strong className="font-medium text-warning">AI is off.</strong> {status.provider} has no default model.{canPick ? " Pick one below and save it." : " Pick one once the key works."}
        </span>
      </p>
    );
  }
  if (status.state === "key_unreadable") {
    return (
      <p role="status" className="flex items-start gap-2 text-sm">
        <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
        <span>
          <strong className="font-medium text-warning">AI is off.</strong> The saved {status.provider} key cannot be read. Replace it in the form above.
        </span>
      </p>
    );
  }
  return null;
}

const endpoint = (connection?: string | null) => `/api/integrations/ai-model${connection ? `?connection=${encodeURIComponent(connection)}` : ""}`;

/**
 * The provider AI runs on and its model, for replies, drafts and AI columns. With several saved keys, the provider
 * picker loads that provider's models; saving switches AI to it. The server checks the model against the live list.
 */
export function AiModelCard({ onReplaceKey }: { onReplaceKey?: (connection: string) => void }) {
  const router = useRouter();
  const [view, setView] = useState<ModelView | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** The provider whose models are loading after a switch in the picker. */
  const [loading, setLoading] = useState<string | null>(null);
  // Each request takes a ticket; only the latest one may update the card, so a slow earlier answer cannot win.
  const latest = useRef(0);

  const apply = useCallback((next: ModelView) => {
    setView(next);
    setChoice(initialChoice(next));
  }, []);

  const load = useCallback(
    async (connection?: string | null) => {
      const ticket = ++latest.current;
      setLoading(connection ?? null);
      const result = await callApi<ModelView>(endpoint(connection), "GET");
      if (ticket !== latest.current) return;
      setLoading(null);
      if (result.ok && result.data) {
        apply(result.data);
        setError(null);
      } else setError(result.error);
    },
    [apply],
  );

  useEffect(() => {
    let cancelled = false;
    const ticket = ++latest.current;
    void callApi<ModelView>(endpoint(), "GET").then((result) => {
      if (cancelled || ticket !== latest.current) return;
      if (result.ok && result.data) apply(result.data);
      else setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [apply]);

  async function save() {
    if (!view?.connection) return;
    setPending(true);
    setError(null);
    // A provider load still in flight would describe the card from before the save, so it no longer applies.
    latest.current++;
    setLoading(null);
    const result = await callApi<ModelView>("/api/integrations/ai-model", "PUT", { connection: view.connection, model: choice === DEFAULT_VALUE ? null : choice });
    setPending(false);
    if (!result.ok || !result.data) {
      setError(result.error);
      return;
    }
    apply(result.data);
    // The Connected list below is server-rendered: refresh it so "Runs AI" and the removal warning follow the switch.
    router.refresh();
    const running = result.data.status;
    const label = view.connections.find((c) => c.key === view.connection)?.label ?? "this provider";
    if (running.state !== "on") toast.success("Model saved.");
    else toast.success(view.active !== view.connection ? `AI now runs on ${label}, ${running.model}.` : `Model saved. AI runs on ${running.model}.`);
  }

  // A provider without a default (the gateways) has no "Default" entry: a model must be picked.
  const hasDefault = view?.defaultModel != null;
  // The default entry and the saved model lead the list; the saved model stays even if the live list dropped it.
  const pinned = useMemo(() => (view ? [...(view.defaultModel != null ? [DEFAULT_VALUE] : []), ...(view.model ? [view.model] : [])] : []), [view]);
  const modelLabel = (value: string) => (value === DEFAULT_VALUE ? `Default (${view?.defaultModel ?? "none"})` : value);
  // "Runs AI now" only while AI runs; the chosen connection with AI off is just the one selected for AI.
  const activeSuffix = view?.status.state === "on" ? " (runs AI now)" : " (selected for AI)";
  const connectionItems = (view?.connections ?? []).map((c) => ({ value: c.key, label: c.key === view?.active ? `${c.label}${activeSuffix}` : c.label }));
  const labelOf = (key: string | null) => view?.connections.find((c) => c.key === key)?.label;
  // Viewing a provider that does not run AI: say what saving does, and that the running key stays.
  const switching = view !== null && view.active !== null && view.connection !== view.active;
  const unchanged = view !== null && view.connection === view.active && choice === initialChoice(view);
  // Demo mode calls no provider, so a model cannot be checked or used: the card says so and offers no picker.
  const demo = view?.status.state === "demo";

  return (
    <SettingsSection title="AI model" description="The provider and model that classify replies, write drafts and fill AI columns for this organization.">
      {demo ? (
        <RunningLine status={view.status} />
      ) : view && !view.connected ? (
        <p className="text-sm text-muted-foreground">{view.notice}</p>
      ) : (
        <>
          {view && <RunningLine status={view.status} canPick={!view.keyRejected} />}
          {connectionItems.length > 1 && (
            <Field>
              <FieldLabel htmlFor="ai-connection">AI provider</FieldLabel>
              <Select items={connectionItems} value={view?.connection ?? ""} onValueChange={(v) => v && void load(v)} disabled={!view || pending}>
                <SelectTrigger id="ai-connection" className="w-full max-w-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {connectionItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {switching && (
                <p className="text-sm text-muted-foreground">
                  Saving switches AI from {labelOf(view.active)} to {labelOf(view.connection)}. The {labelOf(view.active)} key stays saved.
                </p>
              )}
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor="ai-model">Model</FieldLabel>
            <ModelCombobox id="ai-model" ids={view?.choices ?? []} pinned={pinned} value={choice} onValueChange={setChoice} labelOf={modelLabel} disabled={!view || loading !== null || pending} />
            {loading && (
              <p role="status" className="text-sm text-muted-foreground">
                Loading {labelOf(loading)} models…
              </p>
            )}
            {/* The running line already says an unreadable running key is the problem; one warning is enough. */}
            {view?.keyRejected && view.connection && !(view.status.state === "key_unreadable" && view.connection === view.active) && (
              <div role="status" className="flex items-start gap-2 text-sm">
                <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
                <div className="grid gap-2">
                  <p>
                    <strong className="font-medium text-warning">Key rejected.</strong> {labelOf(view.connection)} turned down the saved key, so no model can be listed.{" "}
                    {view.connection === view.active && view.status.state === "on" ? "AI calls fail until you replace it." : "Replace it before AI can run on it."}
                  </p>
                  {onReplaceKey && (
                    <div>
                      <Button variant="outline" size="sm" onClick={() => onReplaceKey(view.connection!)}>
                        Replace key
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            )}
            {view?.notice && (
              <p role="status" className="text-sm text-muted-foreground">
                {view.notice}
              </p>
            )}
          </Field>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div hidden={demo || view?.connected === false}>
        <Button onClick={() => void save()} disabled={pending || !view?.connected || view.keyRejected || unchanged || choice === null || (choice === DEFAULT_VALUE && !hasDefault)}>
          {pending ? "Saving…" : view && view.connection !== view.active ? "Use this provider" : "Save model"}
        </Button>
      </div>
    </SettingsSection>
  );
}
