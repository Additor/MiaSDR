"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-md flex-1 flex-col items-start justify-center gap-4 p-6">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-muted-foreground">
        The page failed to load. Try again, and if it keeps failing, send this reference to your admin{error.digest ? `: ${error.digest}` : "."}
      </p>
      <Button onClick={reset}>Try again</Button>
    </main>
  );
}
