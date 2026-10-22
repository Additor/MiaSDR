"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Time } from "@/components/shell/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { authClient } from "@/contexts/identity/infrastructure/auth-client";
import { cn } from "@/lib/utils";
import { RULED_LIST, RULED_ROW, SettingsSection } from "../settings-section";

interface SessionRow {
  id: string;
  token: string;
  userAgent?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

/** "Chrome on macOS" from a user agent string, or the raw string when no known name fits. */
function deviceName(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown device";
  const browser = /Edg\//.test(userAgent) ? "Edge" : /Firefox\//.test(userAgent) ? "Firefox" : /Chrome\//.test(userAgent) ? "Chrome" : /Safari\//.test(userAgent) ? "Safari" : null;
  const system = /iPhone|iPad/.test(userAgent) ? "iOS" : /Android/.test(userAgent) ? "Android" : /Mac OS X/.test(userAgent) ? "macOS" : /Windows/.test(userAgent) ? "Windows" : /Linux/.test(userAgent) ? "Linux" : null;
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? userAgent.slice(0, 60);
}

/** Your own sign-in: the name others see, the password, and where you are signed in. Every member manages their own. */
export function AccountPanel({ name, email }: { name: string; email: string }) {
  return (
    <div>
      <ProfileSection name={name} email={email} />
      <PasswordSection />
      <SessionsSection />
    </div>
  );
}

function ProfileSection({ name, email }: { name: string; email: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    if (!next) return setError("Enter your name.");
    setPending(true);
    setError(null);
    const { error: failed } = await authClient.updateUser({ name: next });
    setPending(false);
    if (failed) return setError(failed.message ?? "Could not save your name.");
    toast.success("Name saved.");
    router.refresh();
  }

  return (
    <SettingsSection title="Profile" description="Your name shows on conversations you handle, on deals you own and in the history.">
      <form onSubmit={save} className="stack-group">
        <div className="stack-field">
          <Label htmlFor="account-name">Name</Label>
          <Input id="account-name" name="name" defaultValue={name} maxLength={100} required autoComplete="name" className="max-w-sm" />
        </div>
        <div className="stack-field">
          <span className="text-sm font-medium">Email</span>
          <p className="text-sm">{email}</p>
          <p className="text-sm text-muted-foreground">You sign in with this address. It cannot change here.</p>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </SettingsSection>
  );
}

function PasswordSection() {
  // null while loading; the providers this user can sign in with otherwise.
  const [providers, setProviders] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [signOutOthers, setSignOutOthers] = useState(true);

  useEffect(() => {
    let live = true;
    void authClient.listAccounts().then(({ data }) => {
      if (live) setProviders((data ?? []).map((a) => a.providerId));
    });
    return () => {
      live = false;
    };
  }, []);

  async function change(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const currentPassword = String(data.get("current") ?? "");
    const newPassword = String(data.get("next") ?? "");
    if (newPassword !== String(data.get("confirm") ?? "")) return setError("The two new passwords differ.");
    if (newPassword.length < 8) return setError("Use at least 8 characters.");
    setPending(true);
    setError(null);
    const { error: failed } = await authClient.changePassword({ currentPassword, newPassword, revokeOtherSessions: signOutOthers });
    setPending(false);
    if (failed) return setError(failed.message ?? "Could not change the password.");
    form.reset();
    toast.success(signOutOthers ? "Password changed. Other devices are signed out." : "Password changed.");
  }

  const hasPassword = providers?.includes("credential") ?? false;
  return (
    <SettingsSection title="Password">
      {providers === null ? (
        <Skeleton className="h-24 w-full max-w-sm" />
      ) : !hasPassword ? (
        <p className="text-sm text-muted-foreground">You sign in with {providers.includes("google") ? "Google" : "another provider"}, so this account has no password here.</p>
      ) : (
        <form onSubmit={change} className="stack-group">
          <div className="stack-field">
            <Label htmlFor="password-current">Current password</Label>
            <Input id="password-current" name="current" type="password" autoComplete="current-password" required className="max-w-sm" />
          </div>
          <div className="stack-field">
            <Label htmlFor="password-next">New password</Label>
            <Input id="password-next" name="next" type="password" autoComplete="new-password" minLength={8} required aria-describedby="password-next-help" className="max-w-sm" />
            <p id="password-next-help" className="text-sm text-muted-foreground">
              At least 8 characters.
            </p>
          </div>
          <div className="stack-field">
            <Label htmlFor="password-confirm">New password again</Label>
            <Input id="password-confirm" name="confirm" type="password" autoComplete="new-password" minLength={8} required className="max-w-sm" />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="password-sign-out" checked={signOutOthers} onCheckedChange={(c) => setSignOutOthers(c === true)} />
            <Label htmlFor="password-sign-out">Sign out on my other devices</Label>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div>
            <Button type="submit" disabled={pending}>
              {pending ? "Changing…" : "Change password"}
            </Button>
          </div>
        </form>
      )}
    </SettingsSection>
  );
}

function SessionsSection() {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    const [list, session] = await Promise.all([authClient.listSessions(), authClient.getSession()]);
    if (list.error) setError(list.error.message ?? "Could not list your sessions.");
    else {
      setError(null);
      setSessions(list.data as SessionRow[]);
    }
    setCurrent(session.data?.session.token ?? null);
  }, []);

  useEffect(() => {
    const handle = setTimeout(() => void load(), 0);
    return () => clearTimeout(handle);
  }, [load]);

  async function signOutOthers() {
    const { error: failed } = await authClient.revokeOtherSessions();
    if (failed) throw new Error(failed.message ?? "Could not sign out the other devices.");
    toast.success("Other devices are signed out.");
    await load();
  }

  const others = (sessions ?? []).filter((s) => s.token !== current).length;
  return (
    <SettingsSection title="Where you are signed in" description="A device stays signed in until it signs out or its session expires.">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : sessions === null ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <ul className={RULED_LIST} aria-label="Sessions">
          {[...sessions]
            .sort((a, b) => Number(b.token === current) - Number(a.token === current) || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
            .map((s) => (
              <li key={s.id} className={cn(RULED_ROW, "flex flex-wrap items-center gap-x-3 gap-y-1")}>
                <span className="text-sm font-medium">{deviceName(s.userAgent)}</span>
                {s.token === current && <Badge variant="secondary">This device</Badge>}
                <span className="text-sm text-muted-foreground">
                  last active <Time value={new Date(s.updatedAt).toISOString()} />
                </span>
              </li>
            ))}
        </ul>
      )}
      {others > 0 && (
        <div>
          <Button variant="outline" onClick={() => setConfirming(true)}>
            Sign out other devices
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Sign out other devices?"
        description={`${others} other ${others === 1 ? "device signs" : "devices sign"} out. This device stays signed in.`}
        confirmLabel="Sign out other devices"
        cancelLabel="Keep them signed in"
        pendingLabel="Signing out…"
        onConfirm={signOutOthers}
      />
    </SettingsSection>
  );
}
