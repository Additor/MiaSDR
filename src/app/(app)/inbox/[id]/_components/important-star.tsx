"use client";

import { StarIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { callApi } from "@/app/_lib/api-client";

/** Stars or unstars one stored message. The Important view of the inbox lists conversations with a starred message. */
export function ImportantStar({ messageId, important }: { messageId: string; important: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function toggle() {
    setPending(true);
    const result = await callApi(`/api/inbox/messages/${messageId}/important`, "POST", { important: !important });
    setPending(false);
    if (!result.ok) return setError(result.error);
    setError(null);
    router.refresh();
  }

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
        onClick={toggle}
        disabled={pending}
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
