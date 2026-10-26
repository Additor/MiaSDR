"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { callApi } from "@/app/_lib/api-client";

/** Marks the thread read when it opens. The button stays for the case where that call failed. */
export function MarkRead({ id, unread }: { id: string; unread: number }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const attempted = useRef(false);

  async function mark() {
    setPending(true);
    const result = await callApi(`/api/inbox/${id}/read`, "POST");
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    router.refresh();
  }

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
      <Button variant="outline" size="sm" onClick={mark} disabled={pending}>
        Mark as read
      </Button>
    </div>
  );
}
