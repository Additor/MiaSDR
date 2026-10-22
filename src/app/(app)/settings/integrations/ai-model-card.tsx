"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { callApi } from "@/lib/api-client";
import { SettingsSection } from "../settings-section";

interface ModelView {
  connected: boolean;
  connections: Array<{ key: string; label: string }>;
  active: string | null;
  connection: string | null;
  model: string | null;
  effective: string | null;
  defaultModel: string | null;
  choices: string[];
  live: boolean;
  notice: string | null;
}

const DEFAULT_VALUE = "__default__";

/** The select's starting value: the saved model, else "Default" where one exists, else nothing so the placeholder shows. */
const initialChoice = (view: ModelView): string | null => view.model ?? (view.defaultModel != null ? DEFAULT_VALUE : null);

const endpoint = (connection?: string | null) => `/api/integrations/ai-model${connection ? `?connection=${encodeURIComponent(connection)}` : ""}`;

/**
 * The provider AI runs on and its model, for replies, drafts and AI columns. With several saved keys, the provider
 * picker loads that provider's models; saving switches AI to it. The server checks the model against the live list.
 */
export function AiModelCard() {
  const [view, setView] = useState<ModelView | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Each request takes a ticket; only the latest one may update the card, so a slow earlier answer cannot win.
  const latest = useRef(0);

  const apply = useCallback((next: ModelView) => {
    setView(next);
    setChoice(initialChoice(next));
  }, []);

  const load = useCallback(
    async (connection?: string | null) => {
      const ticket = ++latest.current;
      const result = await callApi<ModelView>(endpoint(connection), "GET");
      if (ticket !== latest.current) return;
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
    const result = await callApi<ModelView>("/api/integrations/ai-model", "PUT", { connection: view.connection, model: choice === DEFAULT_VALUE ? null : choice });
    setPending(false);
    if (!result.ok || !result.data) {
      setError(result.error);
      return;
    }
    apply(result.data);
    toast.success(result.data.active === view.connection && view.active !== view.connection ? "AI now runs on this provider." : "Model saved.");
  }

  const choices = view ? Array.from(new Set([...(view.model ? [view.model] : []), ...view.choices])) : [];
  // A provider without a default (the gateways) has no "Default" entry: a model must be picked.
  const hasDefault = view?.defaultModel != null;
  const items = [
    ...(hasDefault || !view ? [{ value: DEFAULT_VALUE, label: view?.defaultModel ? `Default (${view.defaultModel})` : "Default" }] : []),
    ...choices.map((id) => ({ value: id, label: id })),
  ];
  const connectionItems = (view?.connections ?? []).map((c) => ({ value: c.key, label: c.key === view?.active ? `${c.label} (in use)` : c.label }));
  const unchanged = view !== null && view.connection === view.active && choice === initialChoice(view);

  return (
    <SettingsSection title="AI model" description="The provider and model that classify replies, write drafts and fill AI columns for this organization.">
      {view && !view.connected ? (
        <p className="text-sm text-muted-foreground">{view.notice}</p>
      ) : (
        <>
          {connectionItems.length > 1 && (
            <div className="stack-field">
              <Label htmlFor="ai-connection">Provider</Label>
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
            </div>
          )}
          <div className="stack-field">
            <Label htmlFor="ai-model">Model</Label>
            <Select items={items} value={choice} onValueChange={(v) => v && setChoice(v)} disabled={!view}>
              <SelectTrigger id="ai-model" className="w-full max-w-sm">
                <SelectValue placeholder="Pick a model" />
              </SelectTrigger>
              <SelectContent>
                {items.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {view?.notice && <p className="text-sm text-muted-foreground">{view.notice}</p>}
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div>
        <Button onClick={() => void save()} disabled={pending || !view?.connected || unchanged || choice === null || (choice === DEFAULT_VALUE && !hasDefault)}>
          {pending ? "Saving…" : view && view.connection !== view.active ? "Use this provider" : "Save model"}
        </Button>
      </div>
    </SettingsSection>
  );
}
