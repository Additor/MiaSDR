"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { authClient } from "@/contexts/identity/infrastructure/auth-client";
import { GoogleButton } from "../google-button";
import { HOME } from "@/app/_lib/home";

export function SignUpForm({ invitedEmail, invitationId, googleEnabled = false }: { invitedEmail?: string; invitationId?: string; googleEnabled?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email"));
    const { error } = await authClient.signUp.email({
      name: String(form.get("name")),
      email,
      password: String(form.get("password")),
      // An invited person lands on the invitation after confirming, so accepting it is the next step.
      ...(invitationId ? { callbackURL: `/accept-invitation/${invitationId}` } : {}),
    });
    setPending(false);
    if (error) {
      setError(error.message ?? "Could not create the account.");
      return;
    }
    setSentTo(email);
  }

  if (sentTo) {
    return (
      <Card>
        <CardHeader>
          <CardTitle as="h1">Check your email</CardTitle>
          <CardDescription>If {sentTo} can join, a confirmation link is on its way.</CardDescription>
        </CardHeader>
        <CardFooter>
          <Link href="/sign-in" className="text-sm underline">Back to sign in</Link>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card>
      <form onSubmit={onSubmit}>
        <CardHeader>
          <CardTitle as="h1">Create your account</CardTitle>
          <CardDescription>You will get a link to confirm your email.</CardDescription>
        </CardHeader>
        <CardContent className="py-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="name">Name</FieldLabel>
              <Input id="name" name="name" autoComplete="name" required />
            </Field>
            <Field>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input id="email" name="email" type="email" autoComplete="email" defaultValue={invitedEmail} readOnly={Boolean(invitedEmail)} required />
            </Field>
            <Field>
              <FieldLabel htmlFor="password">Password</FieldLabel>
              <Input id="password" name="password" type="password" autoComplete="new-password" minLength={8} required />
            </Field>
            <FieldError>{error}</FieldError>
          </FieldGroup>
        </CardContent>
        <CardFooter className="flex-col gap-group">
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Creating…" : "Create account"}
          </Button>
          {googleEnabled && <GoogleButton callbackURL={invitationId ? `/accept-invitation/${invitationId}` : HOME} />}
          <p className="text-sm text-muted-foreground">
            Have an account? <Link href="/sign-in" className="underline">Sign in</Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}
