"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/shell/empty-state";
import { StatusBadge } from "@/components/shell/status-badge";
import { Time } from "@/components/shell/time";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { runApiAction } from "@/app/_lib/api-action";
import { toastOrThrow } from "@/app/_lib/use-api-action";
import { callApi } from "@/app/_lib/api-client";
import { AiModelCard } from "./ai-model-card";
import { EnrichmentProviders } from "./enrichment-providers";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { RULED_LIST, RULED_ROW, SettingsSection } from "../settings-section";

interface Account {
  id: string;
  kind: string;
  key: string;
  name: string;
  enabled: boolean;
  hasCredential: boolean;
  credentialUpdatedAt: string | null;
  manageHref: string | null;
  runsAi: boolean;
  removalMovesAiTo: string | null;
}

interface Provider {
  key: string;
  label: string;
  description: string;
  fields: Array<{ name: string; label: string }>;
}

/** `aiOn`: AI runs for the organization, so the key selected for AI is marked "Runs AI" and not only "Selected for AI". */
export function IntegrationsPanel({ accounts, providers, aiOn }: { accounts: Account[]; providers: Provider[]; aiOn: boolean }) {
  const router = useRouter();
  const [providerKey, setProviderKey] = useState(providers[0]?.key ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [removing, setRemoving] = useState<Account | null>(null);
  const provider = providers.find((p) => p.key === providerKey);
  const items = providers.map((p) => ({ value: p.key, label: p.label }));
  const connected = new Set(accounts.map((a) => a.key));
  // The AI model card reads its own endpoint once. Saving, replacing or removing an AI key changes this value, which
  // remounts the card after router.refresh() so it describes the keys that exist now.
  const aiKeysRevision = accounts
    .filter((a) => a.kind === "ai")
    .map((a) => `${a.id}:${a.credentialUpdatedAt ?? ""}`)
    .join("|");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!provider) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const values = Object.fromEntries(provider.fields.map((f) => [f.name, String(data.get(f.name) ?? "")]));
    setPending(true);
    setError(null);
    const result = await callApi("/api/integrations", "POST", { providerKey, values });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    form.reset();
    toast.success(connected.has(providerKey) ? "Key replaced." : "Key saved.");
    router.refresh();
  }

  /** Points the key form at `key` and puts the cursor in its first field, for the AI model card's "Replace key". */
  function replaceKey(key: string) {
    const target = providers.find((p) => p.key === key);
    if (!target) return;
    setProviderKey(key);
    // The field renders after the provider changes; focus it on the next frame.
    requestAnimationFrame(() => document.getElementById(target.fields[0]?.name ?? "")?.focus());
  }

  /** What removing `account` does to AI, for the confirm dialog. The server works out where AI goes. */
  function removalEffect(account: Account): string | null {
    if (!account.runsAi) return null;
    return account.removalMovesAiTo ? `AI runs on this key. Removing it moves AI to ${account.removalMovesAiTo}.` : "AI runs on this key. Removing it turns AI off.";
  }

  async function remove(account: Account) {
    toastOrThrow(await runApiAction(callApi(`/api/integrations/${account.id}`, "DELETE"), { refresh: () => router.refresh() }), "Integration removed.");
  }

  return (
    <div>
      <SettingsSection title="AI provider key" description="Keys are encrypted before they are stored and are never shown again. Saving a key for a connected provider replaces the old one.">
        <form onSubmit={save} className="stack-group">
          <Field>
            <FieldLabel htmlFor="provider">Provider</FieldLabel>
            <Select items={items} value={providerKey} onValueChange={(v) => v && setProviderKey(v)}>
              <SelectTrigger id="provider" className="w-full max-w-xs">
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
            {provider && <p className="text-sm text-muted-foreground">{provider.description}</p>}
          </Field>
          {provider?.fields.map((field) => (
            <Field key={`${provider.key}-${field.name}`}>
              <FieldLabel htmlFor={field.name}>{field.label}</FieldLabel>
              <Input id={field.name} name={field.name} type="password" autoComplete="off" required />
            </Field>
          ))}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div>
            <Button type="submit" disabled={pending || !provider}>
              {pending ? "Saving…" : connected.has(providerKey) ? "Replace key" : "Save key"}
            </Button>
          </div>
        </form>
      </SettingsSection>

      <AiModelCard key={aiKeysRevision} onReplaceKey={replaceKey} />

      <SettingsSection title="Connected">
        {accounts.length === 0 ? (
          <EmptyState
            title="Nothing connected yet"
            description="Connect an AI provider above (Anthropic, Vercel AI Gateway or OpenRouter) so the AI can classify replies and write drafts. LinkedIn connects on its own page, enrichment providers below."
            action={{ label: "Open LinkedIn settings", href: "/settings/linkedin" }}
          />
        ) : (
          <ul className={RULED_LIST}>
            {accounts.map((account) => (
              <li key={account.id} className={`flex flex-wrap items-center gap-2 ${RULED_ROW}`}>
                <span className="font-medium">{account.name}</span>
                <StatusBadge status={account.enabled ? "connected" : "disabled"} />
                {account.runsAi && <span className="text-sm font-medium">{aiOn ? "Runs AI" : "Selected for AI"}</span>}
                <span className="text-sm text-muted-foreground">
                  {account.hasCredential ? (
                    <>
                      Key stored{account.credentialUpdatedAt && <>, updated <Time value={account.credentialUpdatedAt} dateOnly /></>}
                    </>
                  ) : (
                    "No key stored here"
                  )}
                </span>
                <div className="ml-auto">
                  {account.manageHref ? (
                    <Button variant="ghost" size="sm" nativeButton={false} render={<Link href={account.manageHref} />}>
                      Manage
                    </Button>
                  ) : (
                    <Button variant="ghost" size="sm" onClick={() => setRemoving(account)}>
                      Remove
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
      <EnrichmentProviders />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.name ?? "this key"}?`}
        description={(removing && removalEffect(removing)) ?? "Anything using this key stops working."}
        confirmLabel="Remove key"
        cancelLabel="Keep key"
        pendingLabel="Removing…"
        destructive
        onConfirm={() => (removing ? remove(removing) : undefined)}
      />
    </div>
  );
}
