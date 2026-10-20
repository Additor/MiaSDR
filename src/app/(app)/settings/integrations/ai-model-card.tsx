"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { callApi } from "@/lib/api-client";
import { SettingsSection } from "../settings-section";

interface ModelView {
  connected: boolean;
  model: string | null;
  effective: string;
  choices: string[];
  live: boolean;
  notice: string | null;
}

const DEFAULT_VALUE = "__default__";

/** Default Claude model for replies and drafts. The server checks the choice against the saved key's live model list. */
export function AiModelCard() {
  const [view, setView] = useState<ModelView | null>(null);
  const [choice, setChoice] = useState(DEFAULT_VALUE);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const apply = useCallback((next: ModelView) => {
    setView(next);
    setChoice(next.model ?? DEFAULT_VALUE);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void callApi<ModelView>("/api/integrations/ai-model", "GET").then((result) => {
      if (cancelled) return;
      if (result.ok && result.data) apply(result.data);
      else setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [apply]);

  async function save() {
    setPending(true);
    setError(null);
    const result = await callApi<ModelView>("/api/integrations/ai-model", "PUT", { model: choice === DEFAULT_VALUE ? null : choice });
    setPending(false);
    if (!result.ok || !result.data) {
      setError(result.error);
      return;
    }
    apply(result.data);
    toast.success(choice === DEFAULT_VALUE ? "Model reset to the default." : "Model saved.");
  }

  const choices = view ? Array.from(new Set([...(view.model ? [view.model] : []), ...view.choices])) : [];
  const items = [{ value: DEFAULT_VALUE, label: view ? `Default (${view.effective})` : "Default" }, ...choices.map((id) => ({ value: id, label: id }))];

  return (
    <SettingsSection title="AI model" description="The Claude model that classifies replies and writes drafts for this organization.">
      {view && !view.connected ? (
        <p className="text-sm text-muted-foreground">{view.notice}</p>
      ) : (
        <div className="stack-field">
          <Label htmlFor="ai-model">Model</Label>
          <Select items={items} value={choice} onValueChange={(v) => v && setChoice(v)} disabled={!view}>
            <SelectTrigger id="ai-model" className="w-full max-w-sm">
              <SelectValue />
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
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div>
        <Button onClick={() => void save()} disabled={pending || !view?.connected || choice === (view.model ?? DEFAULT_VALUE)}>
          {pending ? "Saving…" : "Save model"}
        </Button>
      </div>
    </SettingsSection>
  );
}
