"use client";

import { ChevronRightIcon, RotateCcwIcon, SquareIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { CHAT_MESSAGE_CHARS, isAppLink, partsText, TOOL_LABELS, type ChatPart, type MiaMessageRole, type MiaMessageStatus } from "@/contexts/mia/domain/mia-chat";
import { startTurn } from "../_lib/read-turn";
import { ChatMarkdown } from "./chat-markdown";
import { askKey } from "./new-chat";

export interface ChatMessage {
  id: string;
  turnId: string;
  role: MiaMessageRole;
  status: MiaMessageStatus;
  parts: ChatPart[];
  error: string | null;
}

/** How often a page that opened during an answer reads what the answer saved. */
const POLL_MS = 2_000;

const ENDED: Record<string, string> = {
  stopped: "Stopped.",
  interrupted: "Answer interrupted.",
};

/**
 * One chat: the messages, the box to ask in, Stop while Mia answers and Retry after an answer that did not finish. The
 * answer streams into the page; a page opened during an answer, or one whose stream dropped, reads what was saved.
 */
export function ChatView({ threadId, initial, going: initiallyGoing, unavailable, ask }: { threadId: string; initial: ChatMessage[]; going: boolean; unavailable: string | null; ask?: string }) {
  const router = useRouter();
  const inputId = useId();
  const [messages, setMessages] = useState(initial);
  const [text, setText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [polling, setPolling] = useState(initiallyGoing);
  const [announce, setAnnounce] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const asked = useRef(false);

  // A block body: newer browsers return a Promise from scrollIntoView, and React would take it for a cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  /** Reads the saved chat until no answer is going. */
  const reload = useCallback(async () => {
    const res = await callApi<{ messages: ChatMessage[]; going: boolean }>(`/api/mia/threads/${threadId}`, "GET");
    if (!res.ok || !res.data) return false;
    setMessages(res.data.messages);
    return res.data.going;
  }, [threadId]);

  useEffect(() => {
    if (!polling) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      const going = await reload();
      if (stop) return;
      if (going) setTimeout(tick, POLL_MS);
      else {
        setPolling(false);
        router.refresh();
      }
    };
    const timer = setTimeout(tick, POLL_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [polling, reload, router]);

  /** Asks for an answer and streams it in. `accepted` runs once the server took the turn, before the answer streams. */
  const runTurn = useCallback(
    async (url: string, body: unknown, question: string | null, accepted?: () => void) => {
      setStreaming(true);
      const answerKey = `pending-${Date.now()}`;
      setMessages((list) => [
        ...(question === null ? list.filter((m, i) => !(i === list.length - 1 && m.role === "assistant")) : list),
        ...(question === null ? [] : [{ id: `${answerKey}-q`, turnId: answerKey, role: "user" as const, status: "complete" as const, parts: [{ type: "text" as const, text: question }], error: null }]),
        { id: answerKey, turnId: answerKey, role: "assistant", status: "streaming", parts: [], error: null },
      ]);
      const started = await startTurn(url, body);
      if (!started.ok) {
        setStreaming(false);
        toast.error(started.error);
        if (started.code === "turn_running") setPolling(true);
        await reload();
        return;
      }
      accepted?.();
      const update = (fn: (m: ChatMessage) => ChatMessage) => setMessages((list) => list.map((m) => (m.id === answerKey ? fn(m) : m)));
      let ended = false;
      for await (const event of started.events) {
        if (event.type === "text") update((m) => ({ ...m, parts: appendText(m.parts, event.delta) }));
        else if (event.type === "tool") update((m) => ({ ...m, parts: [...m.parts, event.part] }));
        else if (event.type === "end") {
          ended = true;
          if (event.status !== "duplicate") update((m) => ({ ...m, status: event.status as MiaMessageStatus, error: event.error }));
        }
      }
      setStreaming(false);
      // The full answer for a screen reader, once: the stream itself is not read out word by word.
      setAnnounce("Mia answered.");
      // A dropped stream, or a question sent twice while its first answer still goes: the page reads what the answer saves.
      if (!ended || (await reload())) setPolling(true);
      else router.refresh();
    },
    [reload, router],
  );

  // The box empties once the server took the question, so what a person types during the answer stays for the next one.
  const send = useCallback(
    (question: string, clientId: string) => runTurn(`/api/mia/threads/${threadId}/messages`, { clientId, text: question }, question, () => setText("")),
    [runTurn, threadId],
  );

  // A chat started from the Mia page arrives with its first question, under an id the thread fixes, so a second mount sends nothing twice.
  useEffect(() => {
    if (asked.current || initial.length > 0) return;
    let question = ask ?? null;
    try {
      question = sessionStorage.getItem(askKey(threadId)) ?? question;
      sessionStorage.removeItem(askKey(threadId));
    } catch {
      // Storage is off: the address carried the question, if any.
    }
    if (!question) return;
    asked.current = true;
    if (ask) router.replace(`/mia/${threadId}`, { scroll: false });
    // In the box until the server takes it, so a refusal (a limit, Mia turned off) leaves the question to send again.
    setText(question);
    void send(question, `first-${threadId}`);
  }, [ask, initial.length, send, threadId, router]);

  const busy = streaming || polling;
  const last = messages.at(-1);
  const canRetry = !busy && last?.role === "assistant" && (last.status === "failed" || last.status === "stopped" || last.status === "interrupted");

  async function stop() {
    const res = await runApiAction(callApi(`/api/mia/threads/${threadId}/stop`, "POST"));
    if (!res.ok) toast.error(res.error);
  }

  function submit() {
    const question = text.trim();
    if (question === "" || busy || unavailable) return;
    void send(question, crypto.randomUUID());
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-gutter py-4" data-testid="mia-messages">
        <div className="mx-auto grid max-w-2xl gap-4">
          {messages.length === 0 && <p className="text-sm text-muted-foreground">Ask about your leads, their replies or what Brain holds. Mia reads and answers; it changes nothing.</p>}
          {messages.map((m) => (
            <Message key={m.id} message={m} />
          ))}
          {canRetry && (
            <div>
              <Button variant="outline" size="sm" onClick={() => void runTurn(`/api/mia/threads/${threadId}/retry`, {}, null)}>
                <RotateCcwIcon />
                Retry
              </Button>
            </div>
          )}
          <div ref={end} />
        </div>
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
      <form
        className="border-t px-gutter py-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="mx-auto grid max-w-2xl gap-2">
          <label htmlFor={inputId} className="sr-only">
            Ask Mia
          </label>
          <Textarea
            id={inputId}
            value={text}
            maxLength={CHAT_MESSAGE_CHARS}
            rows={2}
            placeholder={unavailable ?? "Ask Mia about a lead, a reply or Brain"}
            disabled={unavailable !== null}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">Mia can be wrong. Check what it says against the pages it links.</p>
            {busy ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void stop()}>
                <SquareIcon />
                Stop
              </Button>
            ) : (
              <Button type="submit" size="sm" disabled={unavailable !== null || text.trim() === ""}>
                Send
              </Button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}

function appendText(parts: ChatPart[], delta: string): ChatPart[] {
  const last = parts.at(-1);
  if (last?.type === "text") return [...parts.slice(0, -1), { type: "text", text: last.text + delta }];
  return [...parts, { type: "text", text: delta }];
}

function Message({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div className="ml-auto max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap" data-testid="mia-question">
        {partsText(message.parts)}
      </div>
    );
  }
  const tools = message.parts.filter((p): p is Extract<ChatPart, { type: "tool" }> => p.type === "tool");
  const text = partsText(message.parts);
  return (
    <div className="grid gap-2 text-sm" data-testid="mia-answer" data-status={message.status} aria-busy={message.status === "streaming"}>
      {tools.length > 0 && <ToolLine tools={tools} />}
      {text !== "" ? <ChatMarkdown text={text} /> : message.status === "streaming" ? <p className="text-muted-foreground">Mia is reading…</p> : null}
      {message.status === "failed" && <p className="text-destructive">{message.error ?? "Mia could not answer. Try again."}</p>}
      {ENDED[message.status] && <p className="text-muted-foreground">{ENDED[message.status]}</p>}
    </div>
  );
}

/** What Mia read, folded: a person opens it to see the records behind the answer. */
function ToolLine({ tools }: { tools: Extract<ChatPart, { type: "tool" }>[] }) {
  const links = tools.flatMap((t) => t.links).filter((l, i, all) => isAppLink(l.href) && all.findIndex((o) => o.href === l.href) === i);
  const summary = [...new Set(tools.map((t) => TOOL_LABELS[t.name]))].join(", ");
  const failed = tools.filter((t) => t.failed).length;
  return (
    <details className="group text-xs text-muted-foreground">
      <summary className="inline-flex cursor-pointer items-center gap-1 rounded focus-ring">
        <ChevronRightIcon className="size-3 transition-transform group-open:rotate-90" />
        {summary}
        {failed > 0 && ` (${failed} not found)`}
      </summary>
      {links.length > 0 && (
        <ul className="mt-1 ml-4 flex flex-wrap gap-x-3 gap-y-1">
          {links.map((l) => (
            <li key={l.href}>
              <Link href={l.href} className="underline underline-offset-2 hover:text-foreground focus-ring">
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
