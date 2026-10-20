"use client";

import { useEffect } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";

export default function OnboardingError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <>
      <PageHeader title="Setup guide" />
      <div className="page stack-group justify-items-start">
        <p className="text-sm text-muted-foreground">
          The setup guide could not read your progress. Nothing was changed. Try again, and if it keeps failing, send this reference to your admin{error.digest ? `: ${error.digest}` : "."}
        </p>
        <Button onClick={reset}>Try again</Button>
      </div>
    </>
  );
}
