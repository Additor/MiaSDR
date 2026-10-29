"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { HOME } from "@/app/_lib/home";

export function OrganizationForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const name = String(new FormData(event.currentTarget).get("name") ?? "");
    const result = await runApiAction(callApi("/api/organizations", "POST", { name }));
    if (!result.ok) {
      setPending(false);
      setError(result.error);
      return;
    }
    router.push(HOME);
    router.refresh();
  }

  return (
    <Card>
      <form onSubmit={onSubmit}>
        <CardHeader>
          <CardTitle as="h1">New organization</CardTitle>
          <CardDescription>You become its owner and MiaSDR opens in it. Your other organizations stay available from the sidebar.</CardDescription>
        </CardHeader>
        <CardContent className="py-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="name">Organization name</FieldLabel>
              <Input id="name" name="name" maxLength={80} autoComplete="organization" required />
            </Field>
            <FieldError>{error}</FieldError>
          </FieldGroup>
        </CardContent>
        <CardFooter className="flex-col gap-group">
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Creating…" : "Create organization"}
          </Button>
          <Link href={HOME} className="text-sm text-muted-foreground underline">
            Cancel
          </Link>
        </CardFooter>
      </form>
    </Card>
  );
}
