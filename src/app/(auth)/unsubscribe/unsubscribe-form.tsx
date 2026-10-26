"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

export function UnsubscribeForm({ token, email }: { token: string; email: string }) {
  const [state, setState] = useState<"idle" | "pending" | "done" | "error">("idle");

  async function confirm() {
    setState("pending");
    const response = await fetch("/api/outreach/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    setState(response.ok ? "done" : "error");
  }

  if (state === "done") {
    return (
      <Card>
        <CardHeader>
          <CardTitle as="h1">You are unsubscribed</CardTitle>
          <CardDescription>{email} will not receive more emails from this sender.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h1">Unsubscribe</CardTitle>
        <CardDescription>Stop all emails to {email} from this sender?</CardDescription>
      </CardHeader>
      <CardFooter className="flex-col items-stretch gap-2">
        {state === "error" && <p role="alert" className="text-sm text-destructive">Something went wrong. Try again.</p>}
        <Button onClick={confirm} disabled={state === "pending"}>
          {state === "pending" ? "Unsubscribing…" : "Confirm unsubscribe"}
        </Button>
      </CardFooter>
    </Card>
  );
}
