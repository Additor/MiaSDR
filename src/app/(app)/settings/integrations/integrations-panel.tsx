"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/shell/empty-state";
import { StatusBadge } from "@/components/shell/status-badge";
import { Time } from "@/components/shell/time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { callApi } from "@/lib/api-client";
import { AiModelCard } from "./ai-model-card";
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
}

interface Provider {
  key: string;
  label: string;
  description: string;
  fields: Array<{ name: string; label: string }>;
}

export function IntegrationsPanel({ accounts, providers }: { accounts: Account[]; providers: Provider[] }) {
  const router = useRouter();
  const [providerKey, setProviderKey] = useState(providers[0]?.key ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [removing, setRemoving] = useState<Account | null>(null);
  const provider = providers.find((p) => p.key === providerKey);
  const items = providers.map((p) => ({ value: p.key, label: p.label }));
  const connected = new Set(accounts.map((a) => a.key));

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

  async function remove(account: Account) {
    const result = await callApi(`/api/integrations/${account.id}`, "DELETE");
    if (!result.ok) toast.error(result.error ?? "Removal failed.");
    else toast.success("Integration removed.");
    router.refresh();
  }

  return (
    <div>
      <SettingsSection title="Add or replace a key" description="Keys are encrypted before they are stored and are never shown again. Saving a key for a connected provider replaces the old one.">
        <form onSubmit={save} className="stack-group">
          <div className="stack-field">
            <Label htmlFor="provider">Provider</Label>
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
          </div>
          {provider?.fields.map((field) => (
            <div key={`${provider.key}-${field.name}`} className="stack-field">
              <Label htmlFor={field.name}>{field.label}</Label>
              <Input id={field.name} name={field.name} type="password" autoComplete="off" required />
            </div>
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

      <AiModelCard />

      <SettingsSection title="Connected">
        {accounts.length === 0 ? (
          <EmptyState
            title="Nothing connected yet"
            description="Save an Anthropic key above so the AI can classify replies and write drafts. LinkedIn connects on its own page."
            action={{ label: "Open LinkedIn settings", href: "/settings/linkedin" }}
          />
        ) : (
          <ul className={RULED_LIST}>
            {accounts.map((account) => (
              <li key={account.id} className={`flex flex-wrap items-center gap-2 ${RULED_ROW}`}>
                <span className="font-medium">{account.name}</span>
                <StatusBadge status={account.enabled ? "connected" : "disabled"} />
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
                    <Button variant="outline" size="sm" nativeButton={false} render={<Link href={account.manageHref} />}>
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
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.name ?? "this key"}?`}
        description="Anything using this key stops working."
        confirmLabel="Remove key"
        destructive
        onConfirm={() => removing && void remove(removing)}
      />
    </div>
  );
}
