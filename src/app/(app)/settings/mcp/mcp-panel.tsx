"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { EmptyState } from "@/components/shell/empty-state";
import { Time } from "@/components/shell/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { toastOrThrow, useApiAction } from "@/app/_lib/use-api-action";
import { AdminNotice } from "../admin-notice";
import { AgentSends, type AgentSendsData } from "./agent-sends";
import { AgentActivity, type ActivityCall } from "./agent-activity";
import { RULED_LIST, RULED_ROW, SettingsSection } from "../settings-section";

interface Token {
  id: string;
  /** `oauth` is an app the person connected by signing in. */
  kind: "pat" | "oauth";
  name: string;
  hint: string | null;
  scopes: string[];
  ownerUserId: string;
  ownerName: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  /** What it does now: a send or write token loses that when the organization's settings change. */
  access: "read" | "write" | "send";
  sendRetired: boolean;
}

interface Props {
  /** `MCP_ENABLED`: false turns the endpoint off for the whole install. */
  /** The install can act as an OAuth server: `APP_URL` is HTTPS or loopback. */
  oauthAvailable: boolean;
  installEnabled: boolean;
  /** The organization's own switch. */
  enabled: boolean;
  /** Members may create tokens that make changes. Owners and admins always may. */
  memberWriteTokens: boolean;
  /** What agents may send in this organization; a token that sends needs it on. Settings, Organization changes it. */
  agentSendMode: "off" | "replies" | "replies_and_campaigns";
  canManage: boolean;
  currentUserId: string;
  endpoint: string;
  tokenDays: number;
  tokenLimit: number;
  mine: Token[];
  everyone: Token[];
  /** The first page of agent activity, for an owner or admin; null for a member. */
  activity: { calls: ActivityCall[]; more: boolean } | null;
  /** `RETENTION_MCP_TOOL_CALLS_DAYS`: how long the activity list keeps a call. */
  activityDays: number;
  /** What agents sent and started, for an owner or admin; null for a member. */
  agentSends: AgentSendsData | null;
}

/** The client setups the page shows, each with the token in place. */
function clientSetups(endpoint: string, token: string) {
  const server = { url: endpoint, headers: { Authorization: `Bearer ${token}` } };
  return [
    { client: "Claude Code", where: "Run in a terminal.", text: `claude mcp add --transport http miasdr ${endpoint} --header "Authorization: Bearer ${token}"` },
    { client: "Cursor", where: "Add to ~/.cursor/mcp.json.", text: JSON.stringify({ mcpServers: { miasdr: server } }, null, 2) },
    { client: "VS Code", where: "Add to .vscode/mcp.json.", text: JSON.stringify({ servers: { miasdr: { type: "http", ...server } } }, null, 2) },
  ];
}

const isExpired = (token: Token) => token.expiresAt !== null && new Date(token.expiresAt).getTime() <= Date.now();

const copy = (text: string, what: string) =>
  navigator.clipboard.writeText(text).then(
    () => toast.success(`${what} copied.`),
    () => toast.error(`Copy failed. Select the ${what.toLowerCase()} and copy it.`),
  );

/** What agents can send here, said wherever a person decides on access. */
const SEND_NOTE: Record<"off" | "replies" | "replies_and_campaigns", string> = {
  off: "No agent sends email or LinkedIn messages.",
  replies: "Agents with a token that sends can send replies with no one reviewing first.",
  replies_and_campaigns: "Agents with a token that sends can send replies and start campaigns with no one reviewing first.",
};

export function McpPanel({ oauthAvailable, installEnabled, enabled, memberWriteTokens, agentSendMode, canManage, currentUserId, endpoint, tokenDays, tokenLimit, mine, everyone, activity, activityDays, agentSends }: Props) {
  const router = useRouter();
  const refresh = () => router.refresh();
  const { isBusy, run } = useApiAction();
  const [switching, setSwitching] = useState(false);
  const [switchingWrite, setSwitchingWrite] = useState(false);
  const [access, setAccess] = useState<"read" | "write" | "send">("read");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [revoking, setRevoking] = useState<Token | null>(null);
  const [revokingAll, setRevokingAll] = useState(false);
  const usable = installEnabled && enabled;
  const canWrite = canManage || memberWriteTokens;
  // The limit counts live tokens; an expired one stays listed until someone revokes it.
  const myTokens = mine.filter((t) => t.kind === "pat");
  const apps = mine.filter((t) => t.kind === "oauth");
  const live = myTokens.filter((t) => !isExpired(t)).length;

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get("name"));
    void run("create", async () => {
      setError(null);
      const result = await runApiAction(callApi<{ token: string; name: string }>("/api/settings/mcp/tokens", "POST", { name, access: canWrite ? access : "read" }), { refresh, expectData: true });
      if (!result.ok) return setError(result.error);
      form.reset();
      setAccess("read");
      setCreated({ name: result.data.name, token: result.data.token });
    });
  }

  if (!installEnabled) {
    return (
      <SettingsSection title="AI agents (MCP)">
        <p className="text-sm">
          This install has MCP turned off. The server administrator turns it on with the <code className="font-mono text-xs">MCP_ENABLED</code> variable.
        </p>
      </SettingsSection>
    );
  }

  return (
    <div>
      <SettingsSection
        id="access"
        title="Access"
        description={`MCP lets an AI agent, such as Claude Code, Cursor or VS Code, work in this organization's inbox, leads, campaigns, deals and analytics. Each person connects with a personal token, and the agent sees and changes what that person can. ${SEND_NOTE[agentSendMode]}`}
      >
        {enabled ? (
          <p className="text-sm">MCP is on. Agents with a live token can work in this organization.</p>
        ) : (
          <p className="text-sm">MCP is off. Agents cannot connect, and nobody can create a token.</p>
        )}
        {canManage ? (
          <div>
            <Button variant="outline" onClick={() => setSwitching(true)}>
              {enabled ? "Turn off MCP" : "Turn on MCP"}
            </Button>
          </div>
        ) : (
          !enabled && <AdminNotice action="turn on MCP" />
        )}
        <p className="text-sm">
          {memberWriteTokens
            ? "Members can create tokens that make changes, such as drafting replies, adding notes or moving deals."
            : "Only owners and admins can create tokens that make changes. Members' tokens read only."}
        </p>
        {canManage && (
          <div>
            <Button variant="outline" onClick={() => setSwitchingWrite(true)}>
              {memberWriteTokens ? "Limit members to read-only tokens" : "Let members create tokens that make changes"}
            </Button>
          </div>
        )}
      </SettingsSection>

      {(oauthAvailable || apps.length > 0) && (
        <SettingsSection id="apps" title="Connected apps" description={`Apps such as claude.ai or ChatGPT connect when you add ${endpoint} in the app and sign in here. Each stops as soon as you disconnect it.`}>
          {apps.length === 0 ? <p className="text-sm text-muted-foreground">No connected apps yet.</p> : <TokenList tokens={apps} label="Connected apps" showOwner={false} onRevoke={setRevoking} />}
        </SettingsSection>
      )}

      <SettingsSection
        id="tokens"
        title="Your tokens"
        count={myTokens.length > 0 ? `${live} of ${tokenLimit} live` : undefined}
        description={`A token reads what you can read here, and a token that makes changes also changes what you can change. It lasts ${tokenDays} days. Revoke a token you no longer use, or one you think someone else has.`}
      >
        {usable && (
          <form onSubmit={create}>
            <FieldGroup>
              <div className="flex flex-wrap items-end gap-2">
                <Field className="min-w-0 flex-1">
                  <FieldLabel htmlFor="token-name">Token name</FieldLabel>
                  <Input id="token-name" name="name" required maxLength={100} placeholder="Work laptop, Claude Code" />
                </Field>
                <Button type="submit" disabled={isBusy("create")}>
                  {isBusy("create") ? "Creating…" : "Create token"}
                </Button>
              </div>
              {canWrite && (
                <FieldSet>
                  <FieldLegend variant="label" id="token-access-legend">
                    Access
                  </FieldLegend>
                  <RadioGroup aria-labelledby="token-access-legend" value={access} onValueChange={(v) => setAccess(v as "read" | "write" | "send")} className="flex flex-wrap gap-x-6">
                    <Field orientation="horizontal" className="w-auto">
                      <RadioGroupItem value="read" id="token-access-read" />
                      <FieldLabel htmlFor="token-access-read">Read only</FieldLabel>
                    </Field>
                    <Field orientation="horizontal" className="w-auto">
                      <RadioGroupItem value="write" id="token-access-write" />
                      <FieldLabel htmlFor="token-access-write">Read and make changes</FieldLabel>
                    </Field>
                    <Field orientation="horizontal" className="w-auto" data-disabled={agentSendMode === "off" || undefined}>
                      <RadioGroupItem value="send" id="token-access-send" disabled={agentSendMode === "off"} />
                      <FieldLabel htmlFor="token-access-send">Read, make changes and send</FieldLabel>
                    </Field>
                  </RadioGroup>
                  {agentSendMode === "off" ? (
                    <FieldDescription>Agents cannot send in this organization. An owner or admin turns it on under Settings, Organization.</FieldDescription>
                  ) : (
                    access === "send" && (
                      <FieldDescription>
                        An agent with this token sends {agentSendMode === "replies" ? "replies" : "replies and starts campaigns"} as you, with no one reviewing first, within the organization&apos;s agent limits.
                      </FieldDescription>
                    )
                  )}
                </FieldSet>
              )}
              {error && <FieldError>{error}</FieldError>}
            </FieldGroup>
          </form>
        )}
        {created && <NewToken name={created.name} token={created.token} endpoint={endpoint} onDone={() => setCreated(null)} />}
        {myTokens.length === 0 ? (
          <EmptyState className="py-0" title="No tokens" description={usable ? "Create one to connect an agent." : undefined} />
        ) : (
          <TokenList tokens={myTokens} label="Your tokens" showOwner={false} onRevoke={setRevoking} />
        )}
      </SettingsSection>

      {canManage && (
        <SettingsSection
          id="all-tokens"
          title="Every member's tokens"
          description="Revoke one token, or all of them when you suspect a leak. A revoked token stops working on its next request."
          action={
            everyone.length > 0 ? (
              <Button variant="outline" size="sm" onClick={() => setRevokingAll(true)}>
                Revoke all
              </Button>
            ) : undefined
          }
        >
          {everyone.length === 0 ? (
            <EmptyState className="py-0" title="No member has a token" />
          ) : (
            <TokenList tokens={everyone} label="Every member's tokens" showOwner currentUserId={currentUserId} onRevoke={setRevoking} />
          )}
        </SettingsSection>
      )}

      {agentSends && (agentSendMode !== "off" || agentSends.sends.length > 0 || agentSends.campaigns.length > 0) && <AgentSends data={agentSends} />}
      {activity && <AgentActivity initial={activity} retentionDays={activityDays} />}

      <ConfirmDialog
        open={switching}
        onOpenChange={setSwitching}
        title={enabled ? "Turn off MCP?" : "Turn on MCP?"}
        description={
          enabled
            ? "Every agent loses access on its next request. Tokens stay, so turning MCP back on restores them."
            : `Members can then create tokens and connect agents that ${memberWriteTokens ? "read and change" : "read"} what they can. ${SEND_NOTE[agentSendMode]}`
        }
        confirmLabel={enabled ? "Turn off" : "Turn on"}
        cancelLabel={enabled ? "Keep on" : "Keep off"}
        pendingLabel={enabled ? "Turning off…" : "Turning on…"}
        onConfirm={async () => toastOrThrow(await runApiAction(callApi("/api/settings/mcp", "PATCH", { enabled: !enabled }), { refresh }), enabled ? "MCP turned off." : "MCP turned on.")}
      />
      <ConfirmDialog
        open={switchingWrite}
        onOpenChange={setSwitchingWrite}
        title={memberWriteTokens ? "Limit members to read-only tokens?" : "Let members create tokens that make changes?"}
        description={
          memberWriteTokens
            ? "Members' agents stop making changes on their next request and keep reading. Owners and admins keep their tokens as they are."
            : "Members can then create tokens whose agents draft replies, add notes, move deals and change campaigns that have not started, as the member could."
        }
        confirmLabel={memberWriteTokens ? "Limit to read-only" : "Allow changes"}
        cancelLabel="Cancel"
        pendingLabel="Saving…"
        onConfirm={async () =>
          toastOrThrow(
            await runApiAction(callApi("/api/settings/mcp", "PATCH", { memberWriteTokens: !memberWriteTokens }), { refresh }),
            memberWriteTokens ? "Members' tokens read only now." : "Members can create tokens that make changes.",
          )
        }
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`${revoking?.kind === "oauth" ? "Disconnect" : "Revoke"} "${revoking?.name ?? "this token"}"?`}
        description={
          revoking?.kind === "oauth"
            ? "The app stops working on its next request. Connecting it again asks for consent again."
            : revoking && revoking.ownerUserId !== currentUserId
            ? `${revoking.ownerName}'s agent stops working on its next request. They can create a new token.`
            : "The agent that uses it stops working on its next request."
        }
        confirmLabel={revoking?.kind === "oauth" ? "Disconnect" : "Revoke token"}
        cancelLabel={revoking?.kind === "oauth" ? "Keep connected" : "Keep token"}
        pendingLabel="Revoking…"
        destructive
        onConfirm={async () => revoking && toastOrThrow(await runApiAction(callApi(`/api/settings/mcp/tokens/${revoking.id}`, "DELETE"), { refresh }), "Token revoked.")}
      />
      <ConfirmDialog
        open={revokingAll}
        onOpenChange={setRevokingAll}
        title="Revoke every MCP token?"
        description={`All ${everyone.length} tokens of this organization stop working on their next request, yours included. Each person creates a new one to reconnect.`}
        confirmLabel="Revoke all tokens"
        cancelLabel="Keep tokens"
        pendingLabel="Revoking…"
        destructive
        onConfirm={async () => toastOrThrow(await runApiAction(callApi("/api/settings/mcp/tokens/revoke-all", "POST"), { refresh }), "Every token revoked.")}
      />
    </div>
  );
}

/** The secret, shown once, with a setup for each client. */
function NewToken({ name, token, endpoint, onDone }: { name: string; token: string; endpoint: string; onDone: () => void }) {
  return (
    <div className="stack-group rounded-md border p-4 text-sm" role="status">
      <p>
        <strong className="font-medium">Copy the token for &ldquo;{name}&rdquo; now.</strong> It does not show again; if you lose it, revoke it and create another.
      </p>
      <div className="flex items-center gap-2">
        <Input readOnly value={token} aria-label="New token" onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
        <Button type="button" variant="outline" size="sm" onClick={() => void copy(token, "Token")}>
          Copy
        </Button>
      </div>
      {clientSetups(endpoint, token).map((setup) => (
        <div key={setup.client} className="stack-field">
          <div className="flex items-center gap-2">
            <span className="font-medium">{setup.client}</span>
            <span className="text-muted-foreground">{setup.where}</span>
            <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => void copy(setup.text, "Setup")}>
              Copy
            </Button>
          </div>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">{setup.text}</pre>
        </div>
      ))}
      <div>
        <Button type="button" variant="outline" size="sm" onClick={onDone}>
          I copied it
        </Button>
      </div>
    </div>
  );
}

function TokenList({ tokens, label, showOwner, currentUserId, onRevoke }: { tokens: Token[]; label: string; showOwner: boolean; currentUserId?: string; onRevoke: (token: Token) => void }) {
  return (
    <ul className={RULED_LIST} aria-label={label}>
      {tokens.map((token) => {
        const expired = isExpired(token);
        return (
          <li key={token.id} className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-sm ${RULED_ROW}`}>
            <span className="font-medium">{token.name}</span>
            {showOwner && token.kind === "oauth" && <Badge variant="outline">App</Badge>}
            {token.hint && <span className="font-mono text-xs text-muted-foreground">…{token.hint}</span>}
            {showOwner && (
              <span className="text-muted-foreground">
                {token.ownerName}
                {token.ownerUserId === currentUserId && " (you)"}
              </span>
            )}
            {token.access === "send" ? <Badge variant="secondary">Sends</Badge> : token.access === "write" && <Badge variant="secondary">Makes changes</Badge>}
            {token.sendRetired && <Badge variant="outline">No longer sends</Badge>}
            {expired && <Badge variant="outline">Expired</Badge>}
            <span className="text-muted-foreground">
              {token.lastUsedAt ? (
                <>
                  used <Time value={token.lastUsedAt} />
                </>
              ) : (
                "never used"
              )}
              {token.expiresAt && !expired && (
                <>
                  , expires <Time value={token.expiresAt} dateOnly />
                </>
              )}
            </span>
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => onRevoke(token)}>
              {token.kind === "oauth" ? "Disconnect" : "Revoke"}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
