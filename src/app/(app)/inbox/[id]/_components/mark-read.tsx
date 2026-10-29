"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { useApiAction } from "@/app/_lib/use-api-action";

/** Marks the thread read when it opens. The button stays for the case where that call failed. */
export function MarkRead({ id, unread }: { id: string; unread: number }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const { isBusy, run } = useApiAction<"read">();
  const attempted = useRef(false);

  const mark = () =>
    run("read", async () => {
      const result = await runApiAction(callApi(`/api/inbox/${id}/read`, "POST"), { refresh: () => router.refresh() });
      setError(result.ok ? null : result.error);
    });

  useEffect(() => {
    if (unread === 0 || attempted.current) return;
    attempted.current = true;
    void mark();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unread]);

  if (unread === 0) return null;
  return (
    <div className="flex items-center gap-2">
      {error && (
        <span role="alert" className="text-sm text-destructive">
          {error}
        </span>
      )}
      <Button variant="outline" size="sm" onClick={() => void mark()} disabled={isBusy("read")}>
        {isBusy("read") ? "Marking…" : "Mark as read"}
      </Button>
    </div>
  );
}
