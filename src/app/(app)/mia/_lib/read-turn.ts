import type { ChatTurnEvent as TurnEvent } from "@/contexts/mia/domain/mia-chat";

/** What a turn request answers: the stream's events, or the JSON error of a request refused before it started. */
export type TurnStart = { ok: true; events: AsyncGenerator<TurnEvent> } | { ok: false; status: number; error: string; code: string | null };

/** Sends a turn request and reads its answer line by line. A dropped connection ends the events early; the page then reloads what was saved. */
export async function startTurn(url: string, body: unknown): Promise<TurnStart> {
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  } catch {
    return { ok: false, status: 0, error: "Could not reach the server. Check your connection and try again.", code: null };
  }
  if (!response.ok || !response.body) {
    const json = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
    return { ok: false, status: response.status, error: json.error ?? "Mia could not answer. Try again.", code: json.code ?? null };
  }
  return { ok: true, events: lines(response.body) };
}

async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<TurnEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line !== "") yield JSON.parse(line) as TurnEvent;
        newline = buffer.indexOf("\n");
      }
    }
  } catch {
    // The connection dropped. The answer goes on on the server.
  } finally {
    reader.releaseLock();
  }
}
