"use client";

import { TriangleAlertIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { StatusBadge } from "@/components/shell/status-badge";
import { Time, useOrgTimeZone } from "@/components/shell/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { callApi } from "@/app/_lib/api-client";
import { formatDateTime } from "@/shared/format-time";
import { syncLine, type StoredSyncStatus } from "./sync-status";
import { webhookBadge, type StoredWebhookStatus } from "./webhook-status";
import { INVITE_LIMIT_RULE, MESSAGE_LIMIT_RULE, inviteLimitWarning, messageLimitWarning } from "@/contexts/outreach/linkedin/domain/linkedin-limits";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { cn } from "@/components/ui/utils";
import { AdminNotice } from "../admin-notice";
import { SaveRow, useLeaveGuard } from "../settings-form";
import { RULED_LIST, RULED_ROW, SettingsSection } from "../settings-section";
import { hoursDraft, sameHours, toStoredHours, WorkingHoursFields, type StoredHours } from "../working-hours-fields";
import { DailyCounters } from "./daily-counters";

interface Account {
  id: string;
  name: string | null;
  username: string | null;
  status: string;
  isPremium: boolean;
  dailyInviteLimit: number;
  dailyMessageLimit: number;
  messagesToday: number;
  limitReachedUntil: string | null;
  invitesToday: number;
  workingHours: StoredHours | null;
}

interface ConnectLinkRow {
  id: string;
  status: "pending" | "completed" | "expired" | "failed";
  createdAt: string;
  lastError: string | null;
}

interface State {
  connected: boolean;
  dsn: string | null;
  accounts: Account[];
  links: ConnectLinkRow[];
  webhookUrl: string;
  webhooks: StoredWebhookStatus | null;
  sync: StoredSyncStatus | null;
  limits: { invites: { min: number; max: number }; messages: { min: number; max: number } };
}

interface WebhookSetup {
  requestUrl: string;
  headerName: string;
  secret: string;
  webhooks: Array<{ name: string; source: string; event: string; requestUrl: string }>;
}

interface ConnectResult {
  accounts: number;
  added: number;
  webhooks: { status: string; detail: string };
}

export function LinkedInPanel({ state, canManage, zones }: { state: State | null; canManage: boolean; zones: string[] }) {
  const router = useRouter();
  const timeZone = useOrgTimeZone();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);
  const params = useSearchParams();
  const returned = useRef(false);
  const [setup, setSetup] = useState<WebhookSetup | null>(null);
  const [editingCredentials, setEditingCredentials] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  // Back from the Unipile wizard: pull the new account in at once, then drop the query so a reload does not repeat it.
  useEffect(() => {
    const outcome = params.get("unipile");
    if (!outcome || returned.current) return;
    returned.current = true;
    (async () => {
      if (outcome === "success") {
        const result = await callApi("/api/linkedin/sync", "POST");
        if (result.ok) toast.success("LinkedIn account connected.");
        else toast.error(result.error ?? "Connected, but the account list could not be refreshed. Choose Sync accounts.");
      } else {
        toast.error("LinkedIn did not connect the account. Start again from Connect a LinkedIn account.");
      }
      router.replace("/settings/linkedin");
      router.refresh();
    })();
  }, [params, router]);

  if (!canManage || !state) return <AdminNotice action="connect or change LinkedIn" replacesPage />;

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError(null);
    const result = await callApi<ConnectResult>("/api/linkedin", "POST", { dsn: data.get("dsn"), apiKey: data.get("apiKey") });
    setPending(false);
    if (!result.ok || !result.data) {
      setError(result.error);
      return;
    }
    form.reset();
    setEditingCredentials(false);
    const message = `Connected. ${result.data.accounts} LinkedIn account(s) found. ${result.data.webhooks.detail}`;
    if (result.data.webhooks.status === "registered") toast.success(message);
    else toast.warning(message);
    router.refresh();
  }

  async function act(label: string, run: () => Promise<{ ok: boolean; error: string | null }>) {
    const result = await run();
    if (!result.ok) toast.error(result.error ?? `${label} failed.`);
    else toast.success(`${label}.`);
    router.refresh();
  }

  /** One full-page navigation to Unipile's wizard. Unipile advises against an iframe. */
  async function startHostedAuth(accountId: string | null) {
    setLinking(accountId ?? "new");
    const result = await callApi<{ url: string }>("/api/linkedin/accounts/hosted-auth", "POST", accountId ? { accountId } : {});
    if (!result.ok || !result.data) {
      setLinking(null);
      toast.error(result.error ?? "Could not create the connection link.");
      return;
    }
    window.location.assign(result.data.url);
  }

  async function revealSetup() {
    const result = await callApi<WebhookSetup>("/api/linkedin/webhooks/setup", "POST");
    if (!result.ok || !result.data) toast.error(result.error ?? "Could not load the webhook setup.");
    else setSetup(result.data);
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied.`);
    } catch {
      toast.error("Could not copy. Select the text and copy it by hand.");
    }
  }

  async function registerWebhooks() {
    const result = await callApi<ConnectResult["webhooks"]>("/api/linkedin/webhooks", "POST");
    if (!result.ok || !result.data) toast.error(result.error ?? "Webhooks failed.");
    else if (result.data.status === "registered") toast.success(result.data.detail);
    else toast.warning(result.data.detail);
    router.refresh();
  }

  return (
    <div>
      <SettingsSection
        title="Unipile connection"
        description={
          state.connected
            ? `Connected to ${state.dsn}.`
            : "Find the DSN and an access token in your Unipile dashboard. MiaSDR checks them, saves the key encrypted, and finds your LinkedIn accounts."
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={state.connected ? "connected" : "disconnected"} />
          {state.connected && (
            <Badge variant={webhookBadge(state.webhooks).variant} title={state.webhooks ? `Last attempt ${formatDateTime(state.webhooks.at, timeZone)}` : undefined}>
              Webhooks: {webhookBadge(state.webhooks).label}
            </Badge>
          )}
        </div>
        <form onSubmit={connect} className="stack-group">
          {(!state.connected || editingCredentials) && (
            <div className="grid gap-group sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="dsn">DSN</FieldLabel>
                <Input id="dsn" name="dsn" placeholder="api1.unipile.com:13111" required autoComplete="off" />
              </Field>
              <Field>
                <FieldLabel htmlFor="apiKey">API key</FieldLabel>
                <Input id="apiKey" name="apiKey" type="password" required autoComplete="off" />
              </Field>
              {state.connected && <p className="text-sm text-muted-foreground sm:col-span-2">Enter new values to replace the saved key.</p>}
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {(!state.connected || editingCredentials) && (
              <Button type="submit" disabled={pending}>
                {pending ? "Checking…" : state.connected ? "Replace credentials" : "Verify and connect"}
              </Button>
            )}
            {state.connected && editingCredentials && (
              <Button type="button" variant="ghost" onClick={() => setEditingCredentials(false)}>
                Cancel
              </Button>
            )}
            {state.connected && !editingCredentials && (
              <>
                <Button type="button" onClick={() => startHostedAuth(null)} disabled={linking !== null}>
                  {linking === "new" ? "Opening Unipile…" : "Connect a LinkedIn account"}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button type="button" variant="ghost" />}>More</DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-auto min-w-48">
                    <DropdownMenuItem onClick={() => setEditingCredentials(true)}>Edit credentials</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => act("Accounts synced", () => callApi("/api/linkedin/sync", "POST"))}>Sync accounts</DropdownMenuItem>
                    <DropdownMenuItem onClick={registerWebhooks}>Register webhooks</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => setConfirmDisconnect(true)}>
                      Disconnect
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>
        </form>
        {state.connected && (
          <details className="group border-t pt-group">
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">Manual webhook setup</summary>
            <div className="grid gap-3 pt-2 text-sm">
              <p className="text-muted-foreground">Use this when automatic registration is skipped or blocked. Create the webhooks in the Unipile dashboard with the URL below and the secret in a custom header.</p>
              {state.webhooks?.hooks.map((hook) => (
                <div key={hook.name} className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={hook.status} />
                  <span>{hook.name}</span>
                  {hook.error && <span className="text-destructive">{hook.error}</span>}
                </div>
              ))}
              {setup ? (
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="webhook-request-url">Request URL</FieldLabel>
                    <div className="flex gap-2">
                      <Input id="webhook-request-url" readOnly value={setup.requestUrl} />
                      <Button type="button" variant="outline" onClick={() => copy(setup.requestUrl, "URL")}>
                        Copy
                      </Button>
                    </div>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="webhook-secret">Header {setup.headerName}</FieldLabel>
                    <div className="flex gap-2">
                      <Input id="webhook-secret" readOnly value={setup.secret} />
                      <Button type="button" variant="outline" onClick={() => copy(setup.secret, "Secret")}>
                        Copy
                      </Button>
                    </div>
                  </Field>
                  <p className="text-muted-foreground">
                    Events: {setup.webhooks.map((h) => `${h.source} / ${h.event}`).join(", ")}. Viewing the secret is recorded in the audit log.
                  </p>
                  <div>
                    <Button type="button" variant="ghost" onClick={() => setSetup(null)}>
                      Hide
                    </Button>
                  </div>
                </FieldGroup>
              ) : (
                <div>
                  <Button type="button" variant="outline" onClick={revealSetup}>
                    Show setup values
                  </Button>
                </div>
              )}
            </div>
          </details>
        )}

        {state.links.length > 0 && (
          <details className="border-t pt-group">
            <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Recent connection links <span className="font-normal text-muted-foreground">({state.links.length})</span>
            </summary>
            <div className="grid gap-1 pt-2 text-sm">
              <p className="text-muted-foreground">A link lasts 15 minutes. It completes when Unipile reports the new account.</p>
              {state.links.map((link) => (
                <div key={link.id} className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={link.status} />
                  <Time value={link.createdAt} className="text-muted-foreground" />
                  {link.lastError && <span className="text-destructive">{link.lastError}</span>}
                </div>
              ))}
            </div>
          </details>
        )}
      </SettingsSection>

      {(state.connected || state.accounts.length > 0) && (
        <SettingsSection title="LinkedIn accounts">
          {state.accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">No LinkedIn accounts yet.</span> Connect a LinkedIn profile in the Unipile dashboard, then choose Sync accounts.
            </p>
          ) : (
            <ul className={RULED_LIST}>
              {state.accounts.map((account) => (
                <AccountRow key={account.id} account={account} limits={{ invites: state.limits.invites, messages: state.limits.messages }} zones={zones} reconnecting={linking === account.id} onReconnect={() => startHostedAuth(account.id)} onChanged={() => router.refresh()} />
              ))}
            </ul>
          )}
          {state.connected && <SyncLine sync={state.sync} />}
        </SettingsSection>
      )}
      {state.connected && state.accounts.length > 0 && <DailyCounters />}
      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect Unipile?"
        description="MiaSDR deletes the saved key and removes its webhooks at Unipile. Every LinkedIn account shows as disconnected until you connect again."
        confirmLabel="Disconnect Unipile"
        cancelLabel="Stay connected"
        pendingLabel="Disconnecting…"
        destructive
        onConfirm={() => act("Disconnected", () => callApi("/api/linkedin", "DELETE"))}
      />
    </div>
  );
}

function SyncLine({ sync }: { sync: StoredSyncStatus | null }) {
  const line = syncLine(sync, useOrgTimeZone());
  if (!line) return null;
  return (
    <p className={line.failed ? "text-sm text-destructive" : "text-sm text-muted-foreground"} title={line.title} data-testid="linkedin-sync-line">
      {line.text}
    </p>
  );
}

function AccountRow({
  account,
  limits,
  zones,
  reconnecting,
  onReconnect,
  onChanged,
}: {
  account: Account;
  limits: State["limits"];
  zones: string[];
  reconnecting: boolean;
  onReconnect: () => void;
  onChanged: () => void;
}) {
  const orgTimeZone = useOrgTimeZone();
  const saved = { invites: String(account.dailyInviteLimit), messages: String(account.dailyMessageLimit), premium: account.isPremium, hours: hoursDraft(account.workingHours, orgTimeZone) };
  const [values, setValues] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty = Number(values.invites) !== account.dailyInviteLimit || Number(values.messages) !== account.dailyMessageLimit || values.premium !== account.isPremium || !sameHours(values.hours, saved.hours);
  useLeaveGuard(dirty);

  const inviteNumber = Number(values.invites);
  const messageNumber = Number(values.messages);
  const inviteWarning = Number.isInteger(inviteNumber) && inviteNumber >= INVITE_LIMIT_RULE.min && inviteNumber <= INVITE_LIMIT_RULE.max ? inviteLimitWarning(inviteNumber, values.premium) : null;
  const messageWarning = Number.isInteger(messageNumber) && messageNumber >= MESSAGE_LIMIT_RULE.min && messageNumber <= MESSAGE_LIMIT_RULE.max ? messageLimitWarning(messageNumber) : null;
  const name = account.name ?? account.username ?? "LinkedIn account";

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (values.hours.days.length === 0) return setError("Pick at least one sending day.");
    setSaving(true);
    setError(null);
    const result = await callApi<{ warnings: string[] }>(`/api/linkedin/accounts/${account.id}`, "PATCH", {
      dailyInviteLimit: inviteNumber,
      dailyMessageLimit: messageNumber,
      isPremium: values.premium,
      workingHours: toStoredHours(values.hours),
    });
    setSaving(false);
    if (!result.ok) return setError(result.error ?? "Could not save the account.");
    toast.success(`${name} saved.`);
    for (const warning of result.data?.warnings ?? []) toast.warning(warning);
    onChanged();
  }

  return (
    <li data-testid="linkedin-account" className={cn(RULED_ROW, "stack-group")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="stack-field min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">{name}</h3>
            <StatusBadge status={account.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {account.invitesToday} of {account.dailyInviteLimit} invitations and {account.messagesToday} of {account.dailyMessageLimit} messages used today.
            {account.limitReachedUntil && (
              <>
                {" "}
                LinkedIn reported a limit, so this account rests until <Time value={account.limitReachedUntil} />.
              </>
            )}
          </p>
        </div>
        {account.status !== "connected" && (
          <Button variant="ghost" size="sm" onClick={onReconnect} disabled={reconnecting}>
            {reconnecting ? "Opening Unipile…" : "Reconnect"}
          </Button>
        )}
      </div>
      <form onSubmit={save}>
        <FieldGroup>
          <div className="flex flex-wrap items-end gap-group">
            <Field className="w-auto">
              <FieldLabel htmlFor={`limit-${account.id}`}>Invitations per day</FieldLabel>
              <Input id={`limit-${account.id}`} type="number" min={limits.invites.min} max={limits.invites.max} value={values.invites} onChange={(e) => setValues({ ...values, invites: e.target.value })} className="w-28" required />
            </Field>
            <Field className="w-auto">
              <FieldLabel htmlFor={`message-limit-${account.id}`}>Messages per day</FieldLabel>
              <Input id={`message-limit-${account.id}`} type="number" min={limits.messages.min} max={limits.messages.max} value={values.messages} onChange={(e) => setValues({ ...values, messages: e.target.value })} className="w-28" required />
            </Field>
            <Field orientation="horizontal" className="min-h-8 w-auto">
              <Checkbox id={`premium-${account.id}`} checked={values.premium} onCheckedChange={(v) => setValues({ ...values, premium: v === true })} />
              <FieldLabel htmlFor={`premium-${account.id}`}>Paid LinkedIn plan</FieldLabel>
            </Field>
          </div>
          {(inviteWarning || messageWarning) && (
            // A limit above LinkedIn's comfort zone is a risk, not an error: the warning hue on the icon only.
            <div className="stack-field text-sm" role="status">
              {inviteWarning && (
                <p className="flex items-start gap-2">
                  <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
                  {inviteWarning}
                </p>
              )}
              {messageWarning && (
                <p className="flex items-start gap-2">
                  <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
                  {messageWarning}
                </p>
              )}
            </div>
          )}
          <WorkingHoursFields id={`hours-${account.id}`} value={values.hours} onChange={(hours) => setValues({ ...values, hours })} zones={zones} />
          <SaveRow dirty={dirty} pending={saving} error={error} onDiscard={() => setValues(saved)} />
        </FieldGroup>
      </form>
    </li>
  );
}
