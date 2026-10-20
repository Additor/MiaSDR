"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/contexts/identity/infrastructure/auth-client";

/**
 * Starts the Google OAuth flow. The server pages render it only when GOOGLE_CLIENT_ID and
 * GOOGLE_CLIENT_SECRET are set. A refused sign-up (invite-only without an invitation) comes back to
 * `errorCallbackURL` with an `error` query parameter.
 */
export function GoogleButton({ callbackURL, errorCallbackURL = "/sign-in" }: { callbackURL: string; errorCallbackURL?: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setError(null);
    setPending(true);
    const { error } = await authClient.signIn.social({ provider: "google", callbackURL, errorCallbackURL });
    // On success the browser leaves for Google, so only a failed start returns here.
    if (error) {
      setPending(false);
      setError(error.message ?? "Could not start Google sign-in.");
    }
  }

  return (
    <div className="grid w-full gap-2">
      <Button type="button" variant="outline" className="w-full" disabled={pending} onClick={start}>
        {pending ? "Opening Google…" : "Continue with Google"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
