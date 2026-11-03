"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { orThrow, runApiAction, type ActionResult } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { useApiAction } from "@/app/_lib/use-api-action";
import { newIdempotencyKey } from "@/app/(app)/crm/_components/deal-effects";
import { sendKeyAfter } from "../_lib/reply-panel";

/** What a reply card is doing, for the one label that says so. The card's actions share one busy key, since each changes its one open draft. */
export type ReplyWork = "send" | "save" | "draft" | "regen" | "resolve";

/**
 * The idempotency key of a card's Send. `take` answers the key of this decision, so a double click or a retry after a lost
 * response replays one send, and `settle` applies `sendKeyAfter` and answers whether the key stays. A key belongs to one
 * draft state (`draftState`): a new draft, revision or status is a new decision.
 */
export function useSendKey(draftState: string) {
  const key = useRef("");
  useEffect(() => {
    key.current = "";
  }, [draftState]);
  return {
    take: () => (key.current ||= newIdempotencyKey()),
    settle: (result: Parameters<typeof sendKeyAfter>[1]) => {
      key.current = sendKeyAfter(key.current, result);
      return key.current !== "";
    },
    drop: () => {
      key.current = "";
    },
  };
}

/**
 * The draft actions both reply cards share. `work` runs one action at a time and clears the last error; `change` also shows
 * a failure's sentence and answers whether the change went through. A send has its own rules, so each card passes it to `work`.
 */
export function useDraftActions(conversationId: string) {
  const router = useRouter();
  const { run, busyTag } = useApiAction<"reply">();
  const [error, setError] = useState<string | null>(null);
  const refresh = () => router.refresh();

  function work(tag: ReplyWork, action: () => Promise<void>) {
    return run(
      "reply",
      () => {
        setError(null);
        return action();
      },
      tag,
    );
  }

  async function change(tag: ReplyWork, call: () => Promise<ActionResult<unknown>>): Promise<boolean> {
    let done = false;
    await work(tag, async () => {
      const result = await call();
      done = result.ok;
      if (!result.ok) setError(result.error);
    });
    return done;
  }

  return {
    busy: busyTag("reply") as ReplyWork | null,
    error,
    setError,
    work,
    change,
    refresh,
    requestDraft: () => change("draft", () => runApiAction(callApi(`/api/inbox/${conversationId}/draft`, "POST"), { refresh })),
    regenerate: (draftId: string, revision: number, note: string) => change("regen", () => runApiAction(callApi(`/api/drafts/${draftId}/regenerate`, "POST", { revision, note }), { refresh })),
    resolve: (draftId: string, outcome: "delivered" | "not_delivered", note: string) => change("resolve", () => runApiAction(callApi(`/api/drafts/${draftId}/resolve`, "POST", { outcome, note }), { refresh })),
    // A ConfirmDialog stays open with the failure's sentence.
    discard: async (draftId: string, revision: number) => {
      orThrow(await runApiAction(callApi(`/api/drafts/${draftId}/discard`, "POST", { revision }), { refresh }));
    },
  };
}
