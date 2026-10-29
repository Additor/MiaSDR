"use client";

import { StarIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { useApiAction } from "@/app/_lib/use-api-action";

/** Stars or unstars one stored message. The Important view of the inbox lists conversations with a starred message. */
export function ImportantStar({ messageId, important }: { messageId: string; important: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const { isBusy, run } = useApiAction<"star">();

  const toggle = () =>
    run("star", async () => {
      const result = await runApiAction(callApi(`/api/inbox/messages/${messageId}/important`, "POST", { important: !important }), { refresh: () => router.refresh() });
      setError(result.ok ? null : result.error);
    });

  return (
    <span className="inline-flex items-center gap-1">
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
      <Button
        type="button"
        size="xs"
        variant={important ? "secondary" : "ghost"}
        onClick={() => void toggle()}
        disabled={isBusy("star")}
        aria-pressed={important}
        aria-label={important ? "Remove important mark" : "Mark as important"}
        touch
      >
        <StarIcon aria-hidden className={important ? "fill-current" : undefined} />
        {important ? "Important" : "Mark important"}
      </Button>
    </span>
  );
}
