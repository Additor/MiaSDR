"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { CHAT_MESSAGE_CHARS } from "@/contexts/mia/domain/mia-chat";

/** Where a new chat's first question waits for the chat page. */
export const askKey = (threadId: string) => `miasdr.mia.ask.${threadId}`;

/** The first question of a new chat. The chat page sends it, so the answer streams where it will stay. */
export function NewChat({ personId, unavailable }: { personId: string | null; unavailable: string | null }) {
  const router = useRouter();
  const inputId = useId();
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);

  async function start() {
    const question = text.trim();
    if (question === "" || pending || unavailable) return;
    setPending(true);
    const res = await runApiAction(callApi<{ id: string }>("/api/mia/threads", "POST", { personId }), { expectData: true });
    if (!res.ok) {
      setPending(false);
      toast.error(res.error);
      return;
    }
    // The question waits in this tab for the chat page, so it stays out of the address, the history and the server's logs.
    let handed = false;
    try {
      sessionStorage.setItem(askKey(res.data.id), question);
      handed = true;
    } catch {
      // Storage is off in this browser: the address carries it.
    }
    router.push(handed ? `/mia/${res.data.id}` : `/mia/${res.data.id}?ask=${encodeURIComponent(question)}`);
    // The router keeps this page alive behind the chat, so coming back finds an empty box, not a stuck one.
    setText("");
    setPending(false);
  }

  return (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      <label htmlFor={inputId} className="text-sm font-medium">
        {personId ? "Ask Mia about this lead" : "Ask Mia"}
      </label>
      <Textarea
        id={inputId}
        value={text}
        rows={3}
        maxLength={CHAT_MESSAGE_CHARS}
        disabled={unavailable !== null}
        placeholder={unavailable ?? (personId ? "How did they answer, and do they fit our ICP?" : "Which leads replied this week about pricing?")}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void start();
          }
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">Mia reads your leads, conversations and Brain. It sends nothing and changes nothing.</p>
        <Button type="submit" size="sm" disabled={unavailable !== null || pending || text.trim() === ""}>
          Ask
        </Button>
      </div>
    </form>
  );
}
