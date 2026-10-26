"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/contexts/identity/infrastructure/auth-client";
import { GoogleButton } from "../google-button";
import { safeNext } from "./safe-next";

const NOTICES: Record<string, string> = {
  "no-organization": "Your account does not belong to an organization yet. Ask an admin to invite you.",
};

export function SignInForm({ signupAvailable, googleEnabled = false }: { signupAvailable: boolean; googleEnabled?: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);
  const [resend, setResend] = useState<"idle" | "sending" | "sent" | "limited">("idle");
  const notice = NOTICES[params.get("error") ?? ""];
  const [canCreateOrganization, setCanCreateOrganization] = useState(false);

  // Signed in without an organization: offer the create form when the instance allows it.
  useEffect(() => {
    if (params.get("error") !== "no-organization") return;
    fetch("/api/organizations")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { canCreate?: boolean } | null) => setCanCreateOrganization(body?.canCreate === true))
      .catch(() => undefined);
  }, [params]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setUnverifiedEmail(null);
    setResend("idle");
    setPending(true);
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email")).trim();
    const { error } = await authClient.signIn.email({
      email,
      password: String(form.get("password")),
    });
    setPending(false);
    if (error) {
      if (error.status === 403) setUnverifiedEmail(email);
      setError(error.status === 403 ? "Confirm your email first. Check your inbox for the link." : "Invalid email or password.");
      return;
    }
    router.push(safeNext(params.get("next")));
    router.refresh();
  }

  async function resendLink() {
    if (!unverifiedEmail) return;
    setResend("sending");
    // Better Auth answers the same for known and unknown addresses. Only the rate limit (429) differs,
    // and it does not depend on the address.
    const { error } = await authClient.sendVerificationEmail({ email: unverifiedEmail, callbackURL: safeNext(params.get("next")) });
    setResend(error?.status === 429 ? "limited" : "sent");
  }

  return (
    <Card>
      <form onSubmit={onSubmit}>
        <CardHeader>
          <CardTitle as="h1">Sign in</CardTitle>
          <CardDescription>Use the email and password for your MiaSDR account.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 py-4">
          {notice && (
            <p className="text-sm text-muted-foreground">
              {notice}
              {canCreateOrganization && (
                <>
                  {" "}
                  <Link href="/organizations/new" className="underline">
                    Create an organization
                  </Link>
                </>
              )}
            </p>
          )}
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              <Link href="/forgot-password" className="text-sm text-muted-foreground underline">
                Forgot password?
              </Link>
            </div>
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {unverifiedEmail && (
            <div className="grid gap-1">
              <Button type="button" variant="outline" size="sm" disabled={resend === "sending" || resend === "sent"} onClick={resendLink}>
                {resend === "sending" ? "Sending…" : "Resend verification link"}
              </Button>
              {resend === "sent" && (
                <p role="status" className="text-sm text-muted-foreground">
                  If an account exists for {unverifiedEmail}, we sent a new link.
                </p>
              )}
              {resend === "limited" && (
                <p role="alert" className="text-sm text-destructive">
                  Too many requests. Wait a minute and try again.
                </p>
              )}
            </div>
          )}
        </CardContent>
        <CardFooter className="flex-col gap-3">
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </Button>
          {googleEnabled && <GoogleButton callbackURL={safeNext(params.get("next"))} />}
          {signupAvailable ? (
            <p className="text-sm text-muted-foreground">
              No account? <Link href="/sign-up" className="underline">Create one</Link>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">Accounts are by invitation only.</p>
          )}
        </CardFooter>
      </form>
    </Card>
  );
}
