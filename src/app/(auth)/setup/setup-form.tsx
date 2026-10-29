"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { authClient } from "@/contexts/identity/infrastructure/auth-client";

export function SetupForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email"));
    const password = String(form.get("password"));

    const response = await fetch("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: form.get("name"),
        email,
        password,
        organizationName: form.get("organizationName"),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    });
    if (!response.ok) {
      setPending(false);
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(response.status === 409 ? "This instance is already set up. Sign in instead." : (body?.error ?? "Check the details and try again."));
      return;
    }
    const { error } = await authClient.signIn.email({ email, password });
    setPending(false);
    if (error) {
      router.push("/sign-in");
      return;
    }
    router.push("/onboarding");
    router.refresh();
  }

  return (
    <Card>
      <form onSubmit={onSubmit}>
        <CardHeader>
          <CardTitle as="h1">Set up MiaSDR</CardTitle>
          <CardDescription>Create the first admin account and your organization. No email confirmation is needed for this one.</CardDescription>
        </CardHeader>
        <CardContent className="py-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="name">Your name</FieldLabel>
              <Input id="name" name="name" autoComplete="name" required />
            </Field>
            <Field>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input id="email" name="email" type="email" autoComplete="email" required />
            </Field>
            <Field>
              <FieldLabel htmlFor="password">Password</FieldLabel>
              <Input id="password" name="password" type="password" autoComplete="new-password" minLength={8} required />
            </Field>
            <Field>
              <FieldLabel htmlFor="organizationName">Organization</FieldLabel>
              <Input id="organizationName" name="organizationName" required />
            </Field>
            <FieldError>{error}</FieldError>
          </FieldGroup>
        </CardContent>
        <CardFooter>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Setting up…" : "Create admin"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
