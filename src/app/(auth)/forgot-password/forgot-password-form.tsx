"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/contexts/identity/infrastructure/auth-client";

export function ForgotPasswordForm() {
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const email = String(new FormData(event.currentTarget).get("email")).trim();
    const { error } = await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" });
    setPending(false);
    // Better Auth answers the same way for known and unknown addresses. Only the
    // rate limit (429) shows a different message, and it does not depend on the address.
    if (error?.status === 429) {
      setError("Too many requests. Wait a minute and try again.");
      return;
    }
    setSentTo(email);
  }

  return (
    <Card>
      {sentTo ? (
        <>
          <CardHeader>
            <CardTitle as="h1">Check your email</CardTitle>
            <CardDescription>If an account exists for {sentTo}, we sent a link to reset the password. The link works once and expires in one hour.</CardDescription>
          </CardHeader>
          <CardFooter>
            <Link href="/sign-in" className="text-sm underline">
              Back to sign in
            </Link>
          </CardFooter>
        </>
      ) : (
        <form onSubmit={onSubmit}>
          <CardHeader>
            <CardTitle as="h1">Reset your password</CardTitle>
            <CardDescription>Enter your account email and we will send you a link to choose a new password.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" autoComplete="email" required />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </CardContent>
          <CardFooter className="flex-col gap-3">
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? "Sending…" : "Send reset link"}
            </Button>
            <Link href="/sign-in" className="text-sm text-muted-foreground underline">
              Back to sign in
            </Link>
          </CardFooter>
        </form>
      )}
    </Card>
  );
}
