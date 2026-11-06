import type { TurnHandle, TurnListener } from "@/contexts/mia/application/chat-use-cases";
import type { ChatTurnEvent as TurnEvent } from "@/contexts/mia/domain/mia-chat";

/**
 * Streams an answer as JSON lines while the turn writes it. A browser that leaves stops getting lines and nothing else:
 * the turn runs to its end and stores the answer, so a reload shows it. Errors before the turn starts throw, and
 * `withActor` answers them as JSON like any other route.
 */
export async function turnStream(start: (listener: TurnListener) => Promise<TurnHandle>): Promise<Response> {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let open = true;
  // Lines wait until `start` has gone out, so the browser learns the answer's id first.
  let ready = false;
  const waiting: TurnEvent[] = [];
  const write = (event: TurnEvent) => {
    if (!open || !controller) return;
    try {
      controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      if (event.type === "end") {
        open = false;
        controller.close();
      }
    } catch {
      open = false;
    }
  };
  const send = (event: TurnEvent) => (ready ? write(event) : void waiting.push(event));
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      open = false;
    },
  });
  const handle = await start({
    text: (delta) => send({ type: "text", delta }),
    tool: (part) => send({ type: "tool", part }),
    end: (result) => send({ type: "end", ...result }),
  });
  write({ type: "start", answerId: handle.answerId, started: handle.started });
  ready = true;
  for (const event of waiting.splice(0)) write(event);
  if (!handle.started) write({ type: "end", status: "duplicate", error: null });
  return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}
