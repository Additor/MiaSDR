"use client";

import { CheckCircle2Icon, KeyRoundIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { gridRequest } from "../_lib/data/client";
import type { CatalogEntry, ProviderView } from "../_lib/data/providers";
import { ErrorText, Field } from "./form-bits";

interface Props {
  catalog: CatalogEntry[];
  providers: ProviderView[];
  onChanged: () => Promise<void>;
}

/** The provider catalog with connect, replace key and disconnect. A saved key is never shown again. */
export function ProviderManager({ catalog, providers, onChanged }: Props) {
  return (
    <ul className="grid gap-2">
      {catalog.map((entry) => (
        <li key={entry.key}>
          <ProviderRow entry={entry} provider={providers.find((p) => p.key === entry.key)} onChanged={onChanged} />
        </li>
      ))}
    </ul>
  );
}

function ProviderRow({ entry, provider, onChanged }: { entry: CatalogEntry; provider: ProviderView | undefined; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [baseUrl, setBaseUrl] = useState("");
  const [configText, setConfigText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = entry.status === "available";
  const isHttp = entry.adapter === "http";

  async function save() {
    setBusy(true);
    setError(null);
    const credentials = Object.fromEntries(Object.entries(creds).filter(([, v]) => v.trim() !== ""));
    let config: Record<string, unknown> | undefined;
    if (isHttp && configText.trim()) {
      try {
        config = JSON.parse(configText) as Record<string, unknown>;
      } catch {
        setBusy(false);
        return setError("The configuration is not valid JSON.");
      }
    }
    const res = provider
      ? await gridRequest(`/api/grid/providers/${provider.id}`, "PATCH", { credentials: Object.keys(credentials).length > 0 ? credentials : undefined, ...(isHttp ? { baseUrl: baseUrl || undefined, config } : {}) })
      : await gridRequest("/api/grid/providers", "POST", { adapter: entry.key, credentials, ...(isHttp ? { baseUrl, config } : {}) });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    // The key leaves the form state as soon as it is saved.
    setCreds({});
    setOpen(false);
    toast.success(`${entry.name} ${provider ? "updated" : "connected"}.`);
    await onChanged();
  }

  async function toggle() {
    if (!provider) return;
    const res = await gridRequest(`/api/grid/providers/${provider.id}`, "PATCH", { enabled: !provider.enabled });
    if (!res.ok) toast.error(res.error ?? "Could not update the provider.");
    await onChanged();
  }

  async function disconnect() {
    if (!provider) return;
    const res = await gridRequest(`/api/grid/providers/${provider.id}`, "DELETE");
    if (!res.ok) toast.error(res.error ?? "Could not disconnect the provider.");
    else toast.success(`${entry.name} disconnected.`);
    await onChanged();
  }

  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            {entry.name}
            {!available && <Badge variant="outline">Catalog only</Badge>}
            {provider && provider.hasCredential && (
              <Badge variant="secondary">
                <CheckCircle2Icon /> Key saved
              </Badge>
            )}
            {provider && !provider.enabled && <Badge variant="outline">Off</Badge>}
          </p>
          <p className="text-xs text-muted-foreground">{entry.description}</p>
        </div>
        {available && (
          <div className="flex shrink-0 gap-1.5">
            {provider && (
              <Button type="button" size="sm" variant="ghost" onClick={toggle}>
                {provider.enabled ? "Turn off" : "Turn on"}
              </Button>
            )}
            <Button type="button" size="sm" variant="outline" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              <KeyRoundIcon /> {provider ? (entry.credentialFields.length > 0 ? "Replace key" : "Edit") : "Connect"}
            </Button>
            {provider && (
              <Button type="button" size="sm" variant="ghost" onClick={disconnect}>
                Disconnect
              </Button>
            )}
          </div>
        )}
      </div>
      {open && (
        <form
          className="mt-3 grid gap-3 border-t pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          autoComplete="off"
        >
          {entry.credentialFields.map((f) => (
            <Field key={f.key} label={f.label} htmlFor={`cred-${entry.key}-${f.key}`} hint={provider?.hasCredential ? "Leave blank to keep the saved key. A saved key is never shown again." : undefined}>
              <Input
                id={`cred-${entry.key}-${f.key}`}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={creds[f.key] ?? ""}
                onChange={(e) => setCreds((c) => ({ ...c, [f.key]: e.target.value }))}
                placeholder={provider?.hasCredential ? "Saved" : ""}
              />
            </Field>
          ))}
          {isHttp && (
            <>
              <Field label="Base URL" htmlFor="http-base" hint="https only. The host must be on the operator's allow-list.">
                <Input id="http-base" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com" />
              </Field>
              <Field label="Configuration (JSON)" htmlFor="http-config" hint="Auth mode and the actions this API offers.">
                <Textarea id="http-config" rows={6} className="font-mono text-xs" value={configText} onChange={(e) => setConfigText(e.target.value)} spellCheck={false} />
              </Field>
            </>
          )}
          <ErrorText>{error}</ErrorText>
          <div>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? "Saving..." : provider ? "Save" : "Connect"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
