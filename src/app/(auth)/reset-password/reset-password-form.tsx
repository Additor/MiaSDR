"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { authClient } from "@/contexts/identity/infrastructure/auth-client";

const MIN_LENGTH = 8;

/** `token` is null when the link was missing, malformed or already rejected by the server. */
export function ResetPasswordForm({ token }: { token: string | null }) {
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!token) {
    return (
      <Card>
        <CardHeader>
          <CardTitle as="h1">Link expired</CardTitle>
          <CardDescription>This reset link is invalid, expired or already used. Request a new one.</CardDescription>
        </CardHeader>
        <CardFooter>
          <Link href="/forgot-password" className="text-sm underline">
            Request a new link
          </Link>
        </CardFooter>
      </Card>
    );
  }

  if (done) {
    return (
      <Card>
        <CardHeader>
          <CardTitle as="h1">Password updated</CardTitle>
          <CardDescription>Every device was signed out. Sign in with your new password.</CardDescription>
        </CardHeader>
        <CardFooter>
          <Button nativeButton={false} render={<Link href="/sign-in" />} className="w-full">
            Continue to sign in
          </Button>
        </CardFooter>
      </Card>
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password"));
    if (password.length < MIN_LENGTH) return setError(`Use at least ${MIN_LENGTH} characters.`);
    if (password !== String(form.get("confirm"))) return setError("The passwords do not match.");
    setPending(true);
    const { error } = await authClient.resetPassword({ newPassword: password, token: token ?? undefined });
    setPending(false);
    if (error) {
      setError(error.code === "INVALID_TOKEN" ? "This reset link is invalid, expired or already used." : error.message || "Could not update the password.");
      return;
    }
    setDone(true);
  }

  return (
    <Card>
      <form onSubmit={onSubmit}>
        <CardHeader>
          <CardTitle as="h1">Choose a new password</CardTitle>
          <CardDescription>At least {MIN_LENGTH} characters.</CardDescription>
        </CardHeader>
        <CardContent className="py-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="password">New password</FieldLabel>
              <Input id="password" name="password" type="password" autoComplete="new-password" minLength={MIN_LENGTH} required />
            </Field>
            <Field>
              <FieldLabel htmlFor="confirm">Confirm password</FieldLabel>
              <Input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={MIN_LENGTH} required />
            </Field>
            <FieldError>{error}</FieldError>
          </FieldGroup>
        </CardContent>
        <CardFooter>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Saving…" : "Update password"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
