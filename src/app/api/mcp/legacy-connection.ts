import { randomBytes } from "node:crypto";
import { clientNameOf } from "@/app/_lib/mcp";

/**
 * A 2025-11-25 client names itself only in `initialize`, and this endpoint keeps nothing between requests. So the
 * answer to `initialize` hands the name back inside the session id, and the client sends that id with every later
 * request, as that protocol requires. The id opens nothing: the bearer token still decides each request, and a client
 * could write any name in `clientInfo` anyway, so it carries no signature. A 2026-07-28 client names itself in every
 * request and never gets one.
 */
const SEPARATOR = ".";

/** The client an `initialize` request names, or null for any other request. */
export function initializingClient(body: string): string | null {
  try {
    const message = JSON.parse(body) as { method?: unknown; params?: { clientInfo?: unknown } } | null;
    return message?.method === "initialize" ? clientNameOf(message.params?.clientInfo) : null;
  } catch {
    return null;
  }
}

/** Random first, as the protocol asks of a session id. Base64url keeps the id in the visible ASCII a header needs. */
export const connectionId = (clientName: string): string => `${randomBytes(16).toString("base64url")}${SEPARATOR}${Buffer.from(clientName).toString("base64url")}`;

/** The client name inside a session id. An id this endpoint did not write answers null, and the request goes on. */
export function connectionClient(id: string | null): string | null {
  const encoded = id?.split(SEPARATOR)[1];
  return encoded ? clientNameOf({ name: Buffer.from(encoded, "base64url").toString() }) : null;
}

/** The same answer with the session id on it. */
export function withConnectionId(response: Response, clientName: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Mcp-Session-Id", connectionId(clientName));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
