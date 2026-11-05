"use client";

import { useServerDraft } from "@/app/_lib/use-server-draft";
import { TriangleAlertIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Count } from "@/components/shell/section";
import { StatusBadge } from "@/components/shell/status-badge";
import { StateTip } from "@/app/(app)/_components/person/state-tip";
import { Time, useOrgTimeZone } from "@/components/shell/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { toastOrThrow, toastResult, useApiAction } from "@/app/_lib/use-api-action";
import { formatCount } from "@/shared/format-number";
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
import type { ConnectResult } from "@/contexts/outreach/linkedin/application/linkedin-management";

/** How long a link waits before the next check after one the vendor could not settle. Reading the profile can spend a credit. */
const CONNECT_RETRY_MS = 60_000;

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
  inboundReadAt: string | null;
  /** This vendor's inbox is read, and no read finished lately, so the account sends nothing. */
  inboxStale: boolean;
  invitesToday: number;
  workingHours: StoredHours | null;
  ownerUserId: string | null;
}

interface ConnectLinkRow {
  id: string;
  status: "pending" | "completed" | "expired" | "failed";
  createdAt: string;
  lastError: string | null;
}

interface State {
  connected: boolean;
  /** The connected vendor, or the default one. */
  vendor: { key: string; name: string; pollsConnect: boolean; connectLinks: boolean };
  vendors: Array<{ key: string; name: string }>;
  connectedTo: string | null;
  accounts: Account[];
  links: ConnectLinkRow[];
  /** Null: this vendor has no webhooks to register. */
  webhookUrl: string | null;
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

export function LinkedInPanel({ state, canManage, zones, members, ownerOnConnect }: { state: State | null; canManage: boolean; zones: string[]; members: Array<{ userId: string; name: string }>; ownerOnConnect: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [linking, setLinking] = useState<string | null>(null);
  const [newOwner, setNewOwner] = useState(NO_OWNER);
  const params = useSearchParams();
  const returned = useRef(false);
  const [setup, setSetup] = useState<WebhookSetup | null>(null);
  const [editingCredentials, setEditingCredentials] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const { isBusy, run } = useApiAction<"connect" | "link" | "sync" | "webhooks" | "setup">();
  const pending = isBusy("connect");
  const refresh = () => router.refresh();
  const pendingLinks = state?.vendor.pollsConnect ? state.links.filter((link) => link.status === "pending").map((link) => link.id).join(",") : "";
  const [formVendor, setFormVendor] = useState<string | null>(null);
  const checkingLinks = useRef(false);

  // This vendor's link does not report back, and its page does not return here: ask until the sign-in settles.
  useEffect(() => {
    if (!pendingLinks) return;
    // Every open link, since the person may finish any of them. One pass at a time, across a change of links too: a slow check reads the profile, which spends a credit.
    const settled = new Set<string>();
    const notBefore = new Map<string, number>();
    let stopped = false;
    const timer = setInterval(() => {
      if (checkingLinks.current) return;
      checkingLinks.current = true;
      void (async () => {
        try {
          for (const linkId of pendingLinks.split(",")) {
            if (stopped) return;
            if (settled.has(linkId) || Date.now() < (notBefore.get(linkId) ?? 0)) continue;
            const result = await runApiAction(callApi<{ status: string; error: string | null }>("/api/linkedin/accounts/connect-status", "POST", { linkId }), { expectData: true });
            if (!result.ok) continue;
            if (result.data.status === "pending") {
              if (result.data.error) {
                notBefore.set(linkId, Date.now() + CONNECT_RETRY_MS);
                router.refresh();
              }
              continue;
            }
            settled.add(linkId);
            if (result.data.status === "completed") toast.success("LinkedIn account connected.");
            else toast.error(result.data.error ?? "LinkedIn did not connect the account.");
            router.refresh();
          }
        } finally {
          checkingLinks.current = false;
        }
      })();
    }, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [pendingLinks, router]);

  // Back from the Unipile wizard: pull the new account in at once, then drop the query so a reload does not repeat it.
  useEffect(() => {
    const outcome = params.get("unipile");
    if (!outcome || returned.current) return;
    returned.current = true;
    (async () => {
      if (outcome === "success") {
        const result = await runApiAction(callApi("/api/linkedin/sync", "POST"));
        if (result.ok) toast.success("LinkedIn account connected.");
        else toast.error(`Connected, but the account list could not be refreshed. Choose Sync accounts. ${result.error}`);
      } else {
        toast.error("LinkedIn did not connect the account. Start again from Connect a LinkedIn account.");
      }
      router.replace("/settings/linkedin");
      router.refresh();
    })();
  }, [params, router]);

  if (!canManage || !state) return <AdminNotice action="connect or change LinkedIn" replacesPage />;
  const vendor = state.connected ? state.vendor : (state.vendors.find((item) => item.key === formVendor) ?? state.vendor);
  const hasWebhooks = state.connected ? state.webhookUrl !== null : vendor.key === "unipile";
  const asksDsn = vendor.key === "unipile";
  const syncsTeam = vendor.key === "gtmapi";
  const syncAccounts = () => void run("sync", async () => toastResult(await runApiAction(callApi("/api/linkedin/sync", "POST"), { refresh }), "Accounts synced."));

  function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void run("connect", async () => {
      setError(null);
      const result = await runApiAction(callApi<ConnectResult>("/api/linkedin", "POST", asksDsn ? { dsn: data.get("dsn"), apiKey: data.get("apiKey") } : { vendor: vendor.key, apiKey: data.get("apiKey") }), { refresh, expectData: true });
      if (!result.ok) return setError(result.error);
      form.reset();
      setEditingCredentials(false);
      const message = `Connected. ${result.data.accounts} LinkedIn account(s) found. ${result.data.webhooks.detail}`;
      if (result.data.webhooks.status === "registered") toast.success(message);
      else toast.warning(message);
    });
  }

  /**
   * One full-page navigation to the vendor's page. Unipile advises against an iframe. One link opens at a time: `linking`
   * names the account whose button reads "Opening…" until the page leaves. A page that never returns here opens in a new
   * tab, made before the request so a browser does not block it, and this page asks how the sign-in went.
   */
  const startHostedAuth = (accountId: string | null) =>
    run("link", async () => {
      setLinking(accountId ?? "new");
      const tab = state.vendor.pollsConnect ? window.open("about:blank", "_blank") : null;
      if (tab) tab.opener = null;
      const result = await runApiAction(callApi<{ url: string }>("/api/linkedin/accounts/hosted-auth", "POST", accountId ? { accountId } : newOwner === NO_OWNER ? {} : { ownerUserId: newOwner }), { expectData: true });
      if (!result.ok) {
        setLinking(null);
        tab?.close();
        toast.error(result.error);
        return;
      }
      if (tab) {
        tab.location.href = result.data.url;
        setLinking(null);
        refresh();
        return;
      }
      window.location.assign(result.data.url);
    });

  const revealSetup = () =>
    run("setup", async () => {
      const result = await runApiAction(callApi<WebhookSetup>("/api/linkedin/webhooks/setup", "POST"), { expectData: true });
      if (result.ok) setSetup(result.data);
      else toast.error(result.error);
    });

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied.`);
    } catch {
      toast.error("Could not copy. Select the text and copy it by hand.");
    }
  }

  const registerWebhooks = () =>
    run("webhooks", async () => {
      // A refusal can still have changed the stored webhook state, so the page reloads either way.
      const result = await runApiAction(callApi<ConnectResult["webhooks"]>("/api/linkedin/webhooks", "POST"), { expectData: true });
      refresh();
      if (!result.ok) toast.error(result.error);
      else if (result.data.status === "registered") toast.success(result.data.detail);
      else toast.warning(result.data.detail);
    });

  return (
    <div>
      <SettingsSection
        title={`${vendor.name} connection`}
        description={
          <>
            <Badge variant="outline" className="mr-2">
              Preview
            </Badge>
            A full campaign has not run on a real LinkedIn account yet.{" "}
            {state.connected ? `${state.connectedTo ? `Connected to ${state.connectedTo}.` : `Connected to ${vendor.name}.`}${syncsTeam ? " Every LinkedIn account in this key's team is read here, including its messages." : ""}` : syncsTeam ? "Create an API key in gtm-api. MiaSDR checks it, saves it encrypted, and adds every LinkedIn account in the key's team, including its messages. Set how often gtm-api syncs each account there: replies and acceptances arrive only that fast, and an account sends nothing while its sync has stalled." : !asksDsn ? `Create an API key in ${vendor.name}, Settings, Developers. MiaSDR checks it and saves it encrypted. Replies and acceptances are read from each account about every 10 minutes, and an account sends nothing while those reads fail.` : "Find the DSN and an access token in your Unipile dashboard. MiaSDR checks them, saves the key encrypted, and finds your LinkedIn accounts."}
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={state.connected ? "connected" : "disconnected"} />
          {state.connected && hasWebhooks && (
            <WebhookBadge webhooks={state.webhooks} />
          )}
        </div>
        <form onSubmit={connect} className="stack-group">
          {(!state.connected || editingCredentials) && (
            <div className="grid gap-group sm:grid-cols-2">
              {!state.connected && state.vendors.length > 1 && (
                <Field className="sm:col-span-2">
                  <FieldLabel>LinkedIn provider</FieldLabel>
                  <Select items={state.vendors.map((item) => ({ value: item.key, label: item.name }))} value={vendor.key} onValueChange={(value) => value && setFormVendor(value)}>
                    <SelectTrigger aria-label="LinkedIn provider" className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {state.vendors.map((item) => (
                        <SelectItem key={item.key} value={item.key}>
                          {item.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
              {asksDsn && (
                <Field>
                  <FieldLabel htmlFor="dsn">DSN</FieldLabel>
                  <Input id="dsn" name="dsn" placeholder="api1.unipile.com:13111" required autoComplete="off" />
                </Field>
              )}
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
                {/* A vendor cannot call a local address back, so a link there never learns the account it made: its owner is set on the row. */}
                {state.vendor.connectLinks && ownerOnConnect && (
                  <Select items={ownerChoices(members)} value={newOwner} onValueChange={(v) => v && setNewOwner(v)}>
                    <SelectTrigger aria-label="Owner of the new account" className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ownerChoices(members).map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {state.vendor.connectLinks ? (
                  <Button type="button" onClick={() => void startHostedAuth(null)} disabled={linking !== null}>
                    {linking === "new" ? `Opening ${vendor.name}…` : "Connect a LinkedIn account"}
                  </Button>
                ) : (
                  <Button type="button" onClick={syncAccounts} disabled={isBusy("sync")}>
                    {isBusy("sync") ? "Syncing…" : "Sync accounts"}
                  </Button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button type="button" variant="ghost" />}>More</DropdownMenuTrigger>
                  <DropdownMenuContent className="w-auto min-w-48">
                    <DropdownMenuItem onClick={() => setEditingCredentials(true)}>Edit credentials</DropdownMenuItem>
                    {state.vendor.connectLinks && (
                      <DropdownMenuItem disabled={isBusy("sync")} onClick={syncAccounts}>
                        {isBusy("sync") ? "Syncing…" : "Sync accounts"}
                      </DropdownMenuItem>
                    )}
                    {hasWebhooks && (
                      <DropdownMenuItem disabled={isBusy("webhooks")} onClick={() => void registerWebhooks()}>
                        {isBusy("webhooks") ? "Registering…" : "Register webhooks"}
                      </DropdownMenuItem>
                    )}
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
        {state.connected && hasWebhooks && (
          <details className="group border-t pt-group">
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium focus-ring">Manual webhook setup</summary>
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
                  <Button type="button" variant="outline" disabled={isBusy("setup")} onClick={() => void revealSetup()}>
                    {isBusy("setup") ? "Loading…" : "Show setup values"}
                  </Button>
                </div>
              )}
            </div>
          </details>
        )}

        {state.links.length > 0 && (
          <details className="border-t pt-group">
            <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium focus-ring">
              Recent connection links <Count value={formatCount(state.links.length)} className="font-normal" />
            </summary>
            <div className="stack-field pt-2 text-sm">
              <p className="text-muted-foreground">{state.vendor.pollsConnect ? `A link lasts 48 hours. It completes when you finish signing in at ${vendor.name}, in the tab it opened. Keep this page open, or come back to it.` : `A link lasts 15 minutes. It completes when ${vendor.name} reports the new account.`}</p>
              {state.links.map((link) => (
                <div key={link.id} className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={link.status} />
                  <Time value={link.createdAt} className="text-muted-foreground" />
                  {link.lastError && <span className="text-destructive">{link.lastError}</span>}
                  {state.vendor.pollsConnect && link.status === "pending" && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void run("link", async () => toastResult(await runApiAction(callApi("/api/linkedin/accounts/connect-status", "POST", { linkId: link.id, cancel: true }), { refresh }), "Link cancelled."))}
                    >
                      Cancel
                    </Button>
                  )}
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
              <span className="font-medium text-foreground">No LinkedIn accounts yet.</span> {state.vendor.pollsConnect ? "Choose Connect a LinkedIn account above." : `Connect a LinkedIn profile in the ${vendor.name} dashboard, then choose Sync accounts.`}
            </p>
          ) : (
            <ul className={RULED_LIST}>
              {state.accounts.map((account) => (
                <AccountRow key={account.id} signInAt={state.vendor.connectLinks ? null : vendor.name} account={account} limits={{ invites: state.limits.invites, messages: state.limits.messages }} zones={zones} members={members} reconnecting={linking === account.id} linkOpening={linking !== null} onReconnect={() => void startHostedAuth(account.id)} onChanged={() => router.refresh()} />
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
        title={`Disconnect ${vendor.name}?`}
        description={`MiaSDR deletes the saved key${hasWebhooks ? ` and removes its webhooks at ${vendor.name}` : ""}. Every LinkedIn account shows as disconnected until you connect again.${state.vendor.connectLinks ? "" : ` The accounts stay connected at ${vendor.name}.`}`}
        confirmLabel={`Disconnect ${vendor.name}`}
        cancelLabel="Stay connected"
        pendingLabel="Disconnecting…"
        destructive
        onConfirm={async () => toastOrThrow(await runApiAction(callApi("/api/linkedin", "DELETE"), { refresh }), "Disconnected.")}
      />
    </div>
  );
}

function SyncLine({ sync }: { sync: StoredSyncStatus | null }) {
  const line = syncLine(sync);
  if (!line) return null;
  return (
    <p className={line.failed ? "text-sm text-destructive" : "text-sm text-muted-foreground"} data-testid="linkedin-sync-line">
      {line.error}
      {line.error && line.lastSyncAt && " "}
      {line.lastSyncAt && (
        <>
          Last synced <Time value={line.lastSyncAt} />.
        </>
      )}
      {!line.error && !line.lastSyncAt && "Not synced yet. Accounts sync every hour."}
    </p>
  );
}

/** The webhook state as a badge; the time of the last attempt sits in its tip, on hover, focus and a tap. */
function WebhookBadge({ webhooks }: { webhooks: StoredWebhookStatus | null }) {
  const timeZone = useOrgTimeZone();
  const badge = webhookBadge(webhooks);
  const content = <Badge variant={badge.variant}>Webhooks: {badge.label}</Badge>;
  if (!webhooks) return content;
  return (
    <StateTip trigger={<span tabIndex={0} className="inline-flex rounded-md focus-ring" />} tip={`Last attempt ${formatDateTime(webhooks.at, timeZone)}`}>
      {content}
    </StateTip>
  );
}

/** The owner select's value for an account nobody owns. */
const NO_OWNER = "none";

const ownerChoices = (members: Array<{ userId: string; name: string }>) => [{ value: NO_OWNER, label: "No owner" }, ...members.map((m) => ({ value: m.userId, label: m.name }))];

function AccountRow({
  account,
  limits,
  zones,
  members,
  reconnecting,
  linkOpening,
  onReconnect,
  signInAt,
  onChanged,
}: {
  account: Account;
  limits: State["limits"];
  zones: string[];
  members: Array<{ userId: string; name: string }>;
  reconnecting: boolean;
  /** True while any connection link opens; one opens at a time. */
  linkOpening: boolean;
  onReconnect: () => void;
  /** The vendor whose own app signs an account back in, when this app has no link for it. */
  signInAt: string | null;
  onChanged: () => void;
}) {
  const orgTimeZone = useOrgTimeZone();
  const saved = { invites: String(account.dailyInviteLimit), messages: String(account.dailyMessageLimit), premium: account.isPremium, hours: hoursDraft(account.workingHours, orgTimeZone), owner: account.ownerUserId ?? NO_OWNER };
  const { value: values, setValue: setValues, baseChanged, discard, adoptNext, settling } = useServerDraft(saved);
  const [error, setError] = useState<string | null>(null);
  const { isBusy, run } = useApiAction<"save">();
  const saving = isBusy("save");
  const dirty =
    !settling &&
    (Number(values.invites) !== account.dailyInviteLimit || Number(values.messages) !== account.dailyMessageLimit || values.premium !== account.isPremium || !sameHours(values.hours, saved.hours) || values.owner !== saved.owner);
  const ownerItems = ownerChoices(members);
  useLeaveGuard(dirty);

  const inviteNumber = Number(values.invites);
  const messageNumber = Number(values.messages);
  const inviteWarning = Number.isInteger(inviteNumber) && inviteNumber >= INVITE_LIMIT_RULE.min && inviteNumber <= INVITE_LIMIT_RULE.max ? inviteLimitWarning(inviteNumber, values.premium) : null;
  const messageWarning = Number.isInteger(messageNumber) && messageNumber >= MESSAGE_LIMIT_RULE.min && messageNumber <= MESSAGE_LIMIT_RULE.max ? messageLimitWarning(messageNumber) : null;
  const name = account.name ?? account.username ?? "LinkedIn account";

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (values.hours.days.length === 0) return setError("Pick at least one sending day.");
    void run("save", async () => {
      setError(null);
      const body = {
        dailyInviteLimit: inviteNumber,
        dailyMessageLimit: messageNumber,
        isPremium: values.premium,
        workingHours: toStoredHours(values.hours),
        ...(values.owner !== saved.owner ? { ownerUserId: values.owner === NO_OWNER ? null : values.owner } : {}),
      };
      const result = await runApiAction(callApi<{ warnings: string[] }>(`/api/linkedin/accounts/${account.id}`, "PATCH", body), { refresh: onChanged });
      if (!result.ok) return setError(result.error);
      adoptNext();
      toast.success(`${name} saved.`);
      for (const warning of result.data?.warnings ?? []) toast.warning(warning);
    });
  }

  return (
    <li data-testid="linkedin-account" className={cn(RULED_ROW, "stack-group")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="stack-field min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="heading-item">{name}</h3>
            <StatusBadge status={account.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {formatCount(account.invitesToday)} of {formatCount(account.dailyInviteLimit)} invitations and {formatCount(account.messagesToday)} of {formatCount(account.dailyMessageLimit)} messages used today.
            {account.limitReachedUntil && (
              <>
                {" "}
                LinkedIn reported a limit, so this account rests until <Time value={account.limitReachedUntil} />.
              </>
            )}
            {account.status === "connected" && account.inboxStale && (
              <>
                {" "}
                {account.inboundReadAt ? (
                  <>
                    The inbox was last read <Time value={account.inboundReadAt} />.
                  </>
                ) : (
                  "The inbox has not been read yet."
                )}{" "}
                This account sends nothing until a read finishes, which happens inside its working hours.
              </>
            )}
          </p>
        </div>
        {account.status !== "connected" &&
          (signInAt ? (
            <p className="text-sm text-muted-foreground">Sign in again in {signInAt}, then choose Sync accounts.</p>
          ) : (
            <Button variant="ghost" size="sm" onClick={onReconnect} disabled={linkOpening}>
              {reconnecting ? "Opening…" : "Reconnect"}
            </Button>
          ))}
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
            <Field className="w-auto">
              <FieldLabel htmlFor={`owner-${account.id}`}>Owner</FieldLabel>
              <Select items={ownerItems} value={values.owner} onValueChange={(v) => v && setValues({ ...values, owner: v })}>
                <SelectTrigger id={`owner-${account.id}`} className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ownerItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>An agent&apos;s LinkedIn search uses only accounts its person owns and accounts with no owner.</FieldDescription>
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
          <SaveRow dirty={dirty} pending={saving} error={error} baseChanged={baseChanged} onDiscard={discard} />
        </FieldGroup>
      </form>
    </li>
  );
}
