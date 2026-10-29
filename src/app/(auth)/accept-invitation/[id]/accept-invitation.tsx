"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { authClient } from "@/contexts/identity/infrastructure/auth-client";
import type { InvitationView } from "@/contexts/tenancy/application/invitation-view";
import { HOME } from "@/app/_lib/home";

const ROLE_LABEL: Record<string, string> = { owner: "an owner", admin: "an admin", member: "a member" };

function Notice({ title, description, children }: { title: string; description: ReactNode; children?: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h1">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {children && <CardFooter className="flex-col items-stretch gap-group">{children}</CardFooter>}
    </Card>
  );
}

export function AcceptInvitation({ invitationId, view }: { invitationId: string; view: InvitationView }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"accept" | "decline" | "sign-out" | null>(null);
  const next = encodeURIComponent(`/accept-invitation/${invitationId}`);

  async function run(kind: "accept" | "decline", call: () => Promise<{ error: { message?: string } | null }>, done: () => void) {
    setError(null);
    setPending(kind);
    const { error } = await call();
    setPending(null);
    if (error) {
      setError(error.message ?? "This invitation is no longer valid.");
      // The invitation may have changed state under the page (used in another tab, expired); show the current one.
      router.refresh();
      return;
    }
    done();
  }

  const accept = () =>
    run("accept", () => authClient.organization.acceptInvitation({ invitationId }), () => {
      router.push(HOME);
      router.refresh();
    });
  const decline = () => run("decline", () => authClient.organization.rejectInvitation({ invitationId }), () => router.refresh());

  async function signOut() {
    setPending("sign-out");
    await authClient.signOut();
    router.push(`/sign-in?next=${next}`);
    router.refresh();
  }

  switch (view.state) {
    case "not-found":
      return (
        <Notice title="Invitation not found" description="This link does not match an invitation. It may have been withdrawn, or the address was mistyped. Ask the person who invited you for a new one." />
      );
    case "anonymous":
      return (
        <Notice title={`Join ${view.organizationName}`} description="Sign in, or create an account with the invited email address, to see and accept the invitation.">
          <Link href={`/sign-in?next=${next}`} className="text-center text-sm underline">Sign in</Link>
          <Link href={`/sign-up?invitation=${invitationId}`} className="text-center text-sm underline">Create an account</Link>
        </Notice>
      );
    case "wrong-account":
      return (
        <Notice
          title="This invitation is for a different account"
          description={`You are signed in as ${view.viewerEmail}. The invitation to ${view.organizationName} was sent to another email address. Sign out and use the invited address.`}
        >
          <Button onClick={signOut} disabled={pending === "sign-out"}>{pending === "sign-out" ? "Signing out…" : "Sign out"}</Button>
        </Notice>
      );
    case "expired":
      return (
        <Notice
          title="Invitation expired"
          description={`The invitation to ${view.organizationName} from ${view.inviterName} expired on ${new Date(view.expiresAt).toLocaleDateString("en", { dateStyle: "long" })}. Ask ${view.inviterName} to send a new one.`}
        />
      );
    case "used":
      return (
        <Notice title="Invitation already used" description={`This invitation to ${view.organizationName} was accepted. Open the app to continue.`}>
          <Link href={HOME} className="text-center text-sm underline">Open MiaSDR</Link>
        </Notice>
      );
    case "declined":
      return (
        <Notice title="Invitation declined" description={`You declined the invitation to ${view.organizationName}. Ask ${view.inviterName} for a new one if you change your mind.`} />
      );
    case "ready":
      return (
        <Card>
          <CardHeader>
            <CardTitle as="h1">Join {view.organizationName}</CardTitle>
            <CardDescription>
              {view.inviterName} invited you to join {view.organizationName} as {ROLE_LABEL[view.role] ?? view.role}. You are signed in as {view.viewerEmail}. The invitation expires on{" "}
              {new Date(view.expiresAt).toLocaleDateString("en", { dateStyle: "long" })}.
            </CardDescription>
          </CardHeader>
          <CardFooter className="flex-col items-stretch gap-group">
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button onClick={accept} disabled={pending !== null}>{pending === "accept" ? "Joining…" : "Accept invitation"}</Button>
            <Button variant="outline" onClick={decline} disabled={pending !== null}>{pending === "decline" ? "Declining…" : "Decline"}</Button>
          </CardFooter>
        </Card>
      );
  }
}
