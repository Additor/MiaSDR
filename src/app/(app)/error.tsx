"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/shell/error-state";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";

export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <>
      <PageHeader title="Something went wrong" />
      <div className="page">
        <ErrorState
          inline
          title="This page failed to load."
          reason={`Try again, and if it keeps failing, send this reference to your admin${error.digest ? `: ${error.digest}` : "."}`}
          action={<Button onClick={retry}>Try again</Button>}
        />
      </div>
    </>
  );
}
