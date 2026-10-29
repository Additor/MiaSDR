"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/shell/error-state";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";

export default function OnboardingError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <>
      <PageHeader title="Setup guide" />
      <div className="page stack-group">
        <ErrorState
          inline
          title="The setup guide could not read your progress. Nothing was changed."
          reason={`Try again, and if it keeps failing, send this reference to your admin${error.digest ? `: ${error.digest}` : "."}`}
          action={<Button onClick={retry}>Try again</Button>}
        />
      </div>
    </>
  );
}
