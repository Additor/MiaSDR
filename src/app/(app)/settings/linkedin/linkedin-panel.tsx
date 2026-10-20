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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callApi } from "@/lib/api-client";
import { formatDateTime } from "@/shared/format-time";
import { syncLine, type StoredSyncStatus } from "./sync-status";
import { webhookBadge, type StoredWebhookStatus } from "./webhook-status";
import { INVITE_LIMIT_RULE, MESSAGE_LIMIT_RULE, inviteLimitWarning, messageLimitWarning } from "@/contexts/outreach/linkedin/domain/linkedin-limits";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { cn } from "@/lib/utils";
import { AdminNotice } from "../admin-notice";
import { RULED_LIST, RULED_ROW, SettingsSection } from "../settings-section";

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
  workingHours: { timeZone: string; days: Record<string, Array<{ start: string; end: string }>> };
}

const DAYS = [
  { key: "1", label: "Mon" },
  { key: "2", label: "Tue" },
  { key: "3", label: "Wed" },
  { key: "4", label: "Thu" },
  { key: "5", label: "Fri" },
  { key: "6", label: "Sat" },
  { key: "0", label: "Sun" },
];

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

export function LinkedInPanel({ state, canManage }: { state: State | null; canManage: boolean }) {
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
              <div className="stack-field">
                <Label htmlFor="dsn">DSN</Label>
                <Input id="dsn" name="dsn" placeholder="api1.unipile.com:13111" required autoComplete="off" />
              </div>
              <div className="stack-field">
                <Label htmlFor="apiKey">API key</Label>
                <Input id="apiKey" name="apiKey" type="password" required autoComplete="off" />
              </div>
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
                <div className="grid gap-2">
                  <div className="grid gap-1">
                    <Label>Request URL</Label>
                    <div className="flex gap-2">
                      <Input readOnly value={setup.requestUrl} />
                      <Button type="button" variant="outline" onClick={() => copy(setup.requestUrl, "URL")}>
                        Copy
                      </Button>
                    </div>
                  </div>
                  <div className="grid gap-1">
                    <Label>Header {setup.headerName}</Label>
                    <div className="flex gap-2">
                      <Input readOnly value={setup.secret} />
                      <Button type="button" variant="outline" onClick={() => copy(setup.secret, "Secret")}>
                        Copy
                      </Button>
                    </div>
                  </div>
                  <p className="text-muted-foreground">
                    Events: {setup.webhooks.map((h) => `${h.source} / ${h.event}`).join(", ")}. Viewing the secret is recorded in the audit log.
                  </p>
                  <div>
                    <Button type="button" variant="ghost" onClick={() => setSetup(null)}>
                      Hide
                    </Button>
                  </div>
                </div>
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
                <AccountRow key={account.id} account={account} limits={{ invites: state.limits.invites, messages: state.limits.messages }} reconnecting={linking === account.id} onReconnect={() => startHostedAuth(account.id)} onChanged={() => router.refresh()} />
              ))}
            </ul>
          )}
          {state.connected && <SyncLine sync={state.sync} />}
        </SettingsSection>
      )}
      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect Unipile?"
        description="MiaSDR deletes the saved key and removes its webhooks at Unipile. Every LinkedIn account shows as disconnected until you connect again."
        confirmLabel="Disconnect"
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
  reconnecting,
  onReconnect,
  onChanged,
}: {
  account: Account;
  limits: State["limits"];
  reconnecting: boolean;
  onReconnect: () => void;
  onChanged: () => void;
}) {
  const [limit, setLimit] = useState(String(account.dailyInviteLimit));
  const [messageLimit, setMessageLimit] = useState(String(account.dailyMessageLimit));
  const [premium, setPremium] = useState(account.isPremium);
  const [saving, setSaving] = useState(false);
  const firstWindow = Object.values(account.workingHours.days).find((w) => w.length > 0)?.[0];
  const [days, setDays] = useState<string[]>(Object.entries(account.workingHours.days).filter(([, w]) => w.length > 0).map(([d]) => d));
  const [timeZone, setTimeZone] = useState(account.workingHours.timeZone);
  const [start, setStart] = useState(firstWindow?.start ?? "09:00");
  const [end, setEnd] = useState(firstWindow?.end ?? "18:00");

  const inviteNumber = Number(limit);
  const messageNumber = Number(messageLimit);
  const inviteWarning = Number.isInteger(inviteNumber) && inviteNumber >= INVITE_LIMIT_RULE.min && inviteNumber <= INVITE_LIMIT_RULE.max ? inviteLimitWarning(inviteNumber, premium) : null;
  const messageWarning = Number.isInteger(messageNumber) && messageNumber >= MESSAGE_LIMIT_RULE.min && messageNumber <= MESSAGE_LIMIT_RULE.max ? messageLimitWarning(messageNumber) : null;

  async function save() {
    setSaving(true);
    const result = await callApi<{ warnings: string[] }>(`/api/linkedin/accounts/${account.id}`, "PATCH", {
      dailyInviteLimit: Number(limit),
      dailyMessageLimit: Number(messageLimit),
      isPremium: premium,
      workingHours: { timeZone, days: Object.fromEntries(days.map((d) => [d, [{ start, end }]])) },
    });
    if (!result.ok) toast.error(result.error ?? "Could not save.");
    else {
      toast.success("Saved.");
      for (const warning of result.data?.warnings ?? []) toast.warning(warning);
    }
    setSaving(false);
    onChanged();
  }

  return (
    <li data-testid="linkedin-account" className={cn(RULED_ROW, "stack-group")}>
      <div className="stack-field">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium">{account.name ?? account.username ?? "LinkedIn account"}</h3>
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
      <div className="flex flex-wrap items-end gap-4">
        <div className="stack-field">
          <Label htmlFor={`limit-${account.id}`}>Invitations per day</Label>
          <Input id={`limit-${account.id}`} type="number" min={limits.invites.min} max={limits.invites.max} value={limit} onChange={(e) => setLimit(e.target.value)} className="w-28" />
        </div>
        <div className="stack-field">
          <Label htmlFor={`message-limit-${account.id}`}>Messages per day</Label>
          <Input id={`message-limit-${account.id}`} type="number" min={limits.messages.min} max={limits.messages.max} value={messageLimit} onChange={(e) => setMessageLimit(e.target.value)} className="w-28" />
        </div>
        <div className="flex min-h-9 items-center gap-2">
          <Checkbox id={`premium-${account.id}`} checked={premium} onCheckedChange={(v) => setPremium(v === true)} />
          <Label htmlFor={`premium-${account.id}`}>Paid LinkedIn plan</Label>
        </div>
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
      <div className="flex flex-wrap items-end gap-4">
        <div className="stack-field">
          <Label htmlFor={`tz-${account.id}`}>Time zone</Label>
          <Input id={`tz-${account.id}`} value={timeZone} onChange={(e) => setTimeZone(e.target.value)} className="w-44" />
        </div>
        <div className="stack-field">
          <Label htmlFor={`start-${account.id}`}>From</Label>
          <Input id={`start-${account.id}`} type="time" value={start} onChange={(e) => setStart(e.target.value)} required />
        </div>
        <div className="stack-field">
          <Label htmlFor={`end-${account.id}`}>Until</Label>
          <Input id={`end-${account.id}`} type="time" value={end} onChange={(e) => setEnd(e.target.value)} required />
        </div>
      </div>
      <fieldset className="stack-field">
        <legend className="pb-field text-sm font-medium">Send on</legend>
        <div className="flex flex-wrap gap-3">
          {DAYS.map((d) => (
            <label key={d.key} className="flex items-center gap-1.5 text-sm">
              <Checkbox checked={days.includes(d.key)} onCheckedChange={(checked) => setDays((all) => (checked ? [...all, d.key] : all.filter((x) => x !== d.key)))} />
              {d.label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {account.status !== "connected" && (
          <Button variant="outline" size="sm" onClick={onReconnect} disabled={reconnecting}>
            {reconnecting ? "Opening Unipile…" : "Reconnect"}
          </Button>
        )}
      </div>
    </li>
  );
}
