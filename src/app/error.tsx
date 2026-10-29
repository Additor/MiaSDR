"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/shell/error-state";
import { Button } from "@/components/ui/button";

/** A failure outside the app shell (the auth pages). It draws the same `ErrorState` the app pages draw, under its own h1. */
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="mx-auto grid min-h-svh w-full max-w-md flex-1 content-center gap-group p-6">
      <h1 className="heading-section">Something went wrong</h1>
      <ErrorState
        inline
        title="The page failed to load."
        reason={`Try again, and if it keeps failing, send this reference to your admin${error.digest ? `: ${error.digest}` : "."}`}
        action={<Button onClick={retry}>Try again</Button>}
      />
    </main>
  );
}
