"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { callApi } from "@/lib/api-client";
import { AdminNotice } from "../admin-notice";
import { RULED_LIST, RULED_ROW, SettingsSection } from "../settings-section";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Time } from "@/components/shell/time";
import { humanizeToken } from "@/shared/humanize";

interface Member {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
}

const ROLES = [
  { value: "owner", label: "Owner" },
  { value: "admin", label: "Admin" },
  { value: "member", label: "Member" },
];
const ROLE_LABELS: Record<string, string> = Object.fromEntries(ROLES.map((r) => [r.value, r.label]));

/** A member can hold several roles ("admin,owner"). The table shows and edits the highest one. */
const primaryRole = (stored: string) => ROLES.find((r) => stored.split(",").includes(r.value))?.value ?? stored.split(",")[0];
const roleLabel = (stored: string) =>
  stored
    .split(",")
    .map((r) => ROLE_LABELS[r.trim()] ?? humanizeToken(r))
    .join(", ");

/** What a person can do after the change, as one sentence for the confirmation. */
const ROLE_CONSEQUENCE: Record<string, (name: string) => string> = {
  owner: (name) => `${name} gets every admin permission and can also rename the organization and grant the owner role.`,
  admin: (name) => `${name} can invite and remove members, connect mailboxes and integrations and change settings, but cannot grant or change the owner role.`,
  member: (name) => `${name} can work leads, campaigns, the inbox and deals, but cannot manage members, mailboxes or integrations.`,
};

interface Props {
  members: Member[];
  invitations: Invitation[];
  currentUserId: string;
  actorIsOwner: boolean;
  canManage: boolean;
  emailConfigured: boolean;
  appUrl: string;
}

export function MembersPanel({ members, invitations, currentUserId, actorIsOwner, canManage, emailConfigured, appUrl }: Props) {
  const router = useRouter();
  const [role, setRole] = useState("member");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [changing, setChanging] = useState<{ member: Member; role: string } | null>(null);
  const [created, setCreated] = useState<{ email: string; link: string } | null>(null);
  // Admins cannot grant or touch the owner role, so the menu hides it for them.
  const grantable = ROLES.filter((r) => actorIsOwner || r.value !== "owner");

  async function act(label: string, run: () => Promise<{ ok: boolean; error: string | null }>) {
    const result = await run();
    if (!result.ok) toast.error(result.error ?? `${label} failed.`);
    else toast.success(`${label}.`);
    router.refresh();
  }

  /** For a ConfirmDialog: a failure throws, so the dialog stays open and shows the message. */
  async function perform(label: string, run: () => Promise<{ ok: boolean; error: string | null }>) {
    const result = await run();
    if (!result.ok) throw new Error(result.error ?? `${label} failed.`);
    toast.success(`${label}.`);
    router.refresh();
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const email = String(new FormData(form).get("email"));
    setPending(true);
    setError(null);
    const result = await callApi<{ id: string }>("/api/members", "POST", { email, role });
    setPending(false);
    if (!result.ok || !result.data) {
      setError(result.error);
      return;
    }
    form.reset();
    setCreated({ email, link: `${appUrl}/accept-invitation/${result.data.id}` });
    router.refresh();
  }

  return (
    <div>
      {canManage ? (
        <SettingsSection title="Invite someone" description="Sign-up is by invitation only. An invitation lasts 7 days.">
          <form onSubmit={invite} className="stack-group">
            <div className="grid gap-group sm:grid-cols-[1fr_12rem]">
              <div className="stack-field">
                <Label htmlFor="email">Email address</Label>
                <Input id="email" name="email" type="email" required />
              </div>
              <div className="stack-field">
                <Label htmlFor="role">Role</Label>
                <Select items={grantable} value={role} onValueChange={(v) => v && setRole(v)}>
                  <SelectTrigger id="role" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {grantable.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div>
              <Button type="submit" disabled={pending}>
                {pending ? "Inviting…" : "Send invitation"}
              </Button>
            </div>
            {created && <AcceptLink email={created.email} link={created.link} emailConfigured={emailConfigured} />}
          </form>
        </SettingsSection>
      ) : (
        <div className="pb-section">
          <AdminNotice action="invite people or change roles" />
        </div>
      )}

      <SettingsSection
        title="Members"
        description="Owners can do everything, including renaming the organization and granting the owner role. Admins manage members, mailboxes, integrations and settings. Members work leads, campaigns, the inbox and deals."
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Role</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((m) => {
              const isSelf = m.userId === currentUserId;
              const locked = !actorIsOwner && m.role.split(",").includes("owner");
              return (
                <TableRow key={m.id}>
                  <TableCell>
                    <div className="font-medium">
                      {m.name} {isSelf && <Badge variant="outline">You</Badge>}
                    </div>
                    <div className="text-sm text-muted-foreground">{m.email}</div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      {canManage && !locked && !isSelf ? (
                        <Select
                          items={ROLES}
                          value={primaryRole(m.role)}
                          onValueChange={(v) => v && v !== primaryRole(m.role) && setChanging({ member: m, role: v })}
                        >
                          <SelectTrigger className="w-32" aria-label={`Role of ${m.email}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {grantable.map((r) => (
                              <SelectItem key={r.value} value={r.value}>
                                {r.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <>
                          <Badge variant="secondary">{roleLabel(m.role)}</Badge>
                          {canManage && isSelf && <span className="text-xs text-muted-foreground">Another owner or admin changes your role.</span>}
                          {canManage && locked && <span className="text-xs text-muted-foreground">Only an owner changes an owner.</span>}
                        </>
                      )}
                      {canManage && !isSelf && !locked && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setRemoving(m)}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </SettingsSection>

      {canManage && (
        <SettingsSection
          title="Pending invitations"
          description={!emailConfigured ? "No email service is configured (RESEND_API_KEY), so nothing was sent. Copy each link and share it yourself." : undefined}
        >
          {invitations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pending invitations.</p>
          ) : (
            <ul className={RULED_LIST}>
              {invitations.map((inv) => (
                <li key={inv.id} className={`grid gap-1 ${RULED_ROW}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{inv.email}</span>
                    <Badge variant="secondary">{roleLabel(inv.role)}</Badge>
                    <span className="text-sm text-muted-foreground">
                      expires <Time value={inv.expiresAt} dateOnly />
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
                      onClick={() => void act("Invitation revoked", () => callApi(`/api/invitations/${inv.id}`, "DELETE"))}
                    >
                      Revoke
                    </Button>
                  </div>
                  {!emailConfigured && <CopyLink link={`${appUrl}/accept-invitation/${inv.id}`} />}
                </li>
              ))}
            </ul>
          )}
        </SettingsSection>
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.email ?? "this member"}?`}
        description="They lose access to this organization."
        confirmLabel="Remove member"
        destructive
        onConfirm={() => removing && perform("Member removed", () => callApi(`/api/members/${removing.id}`, "DELETE"))}
      />
      <ConfirmDialog
        open={changing !== null}
        onOpenChange={(open) => !open && setChanging(null)}
        title={changing ? `Change ${changing.member.name}'s role to ${ROLE_LABELS[changing.role] ?? changing.role}?` : "Change role?"}
        description={changing ? (ROLE_CONSEQUENCE[changing.role]?.(changing.member.name) ?? "") : ""}
        confirmLabel="Change role"
        pendingLabel="Changing..."
        onConfirm={() => changing && perform("Role changed", () => callApi(`/api/members/${changing.member.id}`, "PATCH", { role: changing.role }))}
      />
    </div>
  );
}

function AcceptLink({ email, link, emailConfigured }: { email: string; link: string; emailConfigured: boolean }) {
  return (
    <div className="grid w-full gap-1 text-sm" role="status">
      <p>{emailConfigured ? `Invitation emailed to ${email}.` : `Invitation created for ${email}. No email service is configured, so share this link:`}</p>
      {!emailConfigured && <CopyLink link={link} />}
    </div>
  );
}

function CopyLink({ link }: { link: string }) {
  return (
    <div className="flex w-full items-center gap-2">
      <Input readOnly value={link} aria-label="Invitation link" onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => navigator.clipboard.writeText(link).then(() => toast.success("Link copied."), () => toast.error("Copy failed. Select the link and copy it."))}
      >
        Copy
      </Button>
    </div>
  );
}
