"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function OrganizationForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const name = String(new FormData(event.currentTarget).get("name") ?? "");
    const response = await fetch("/api/organizations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) {
      setPending(false);
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "Could not create the organization. Try again.");
      return;
    }
    router.push("/leads");
    router.refresh();
  }

  return (
    <Card>
      <form onSubmit={onSubmit}>
        <CardHeader>
          <CardTitle as="h1">New organization</CardTitle>
          <CardDescription>You become its owner and MiaSDR opens in it. Your other organizations stay available from the sidebar.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="name">Organization name</Label>
            <Input id="name" name="name" maxLength={80} autoComplete="organization" required />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </CardContent>
        <CardFooter className="flex-col gap-3">
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Creating…" : "Create organization"}
          </Button>
          <Link href="/leads" className="text-sm text-muted-foreground underline">
            Cancel
          </Link>
        </CardFooter>
      </form>
    </Card>
  );
}
