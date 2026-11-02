/*
 * Calls the MCP route handler in-process, the way a client of either protocol era would. The route reads its bearer
 * token from the request headers, not from `next/headers`, so a test needs only the `next/server` stand-in of
 * `route-client.ts` for `connection()`:
 *
 *   vi.mock("server-only", () => ({}));
 *   vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));
 */

export type McpEra = "legacy" | "modern";

export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSION = "2025-11-25";

export interface McpCallOptions {
  era: McpEra;
  /** The bearer token, or null for none. */
  token: string | null;
  method: string;
  params?: Record<string, unknown>;
  /** Overrides a header the era would set, or adds one, such as `origin`. `null` removes it. */
  headers?: Record<string, string | null>;
  httpMethod?: "POST" | "GET" | "DELETE";
}

export interface McpCallResult {
  status: number;
  headers: Headers;
  /** The JSON-RPC message: parsed from JSON, or from the last `data:` line of an SSE body. Text when neither parses. */
  body: unknown;
}

type Handler = (request: Request) => Promise<Response>;

let nextId = 1;

/** The request body and headers an MCP client of the given era sends. */
export function mcpRequest(options: McpCallOptions): Request {
  const params = { ...options.params };
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (options.era === "modern") {
    params._meta = {
      "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
      "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
      ...(params._meta as Record<string, unknown> | undefined),
    };
    headers["mcp-protocol-version"] = MODERN_VERSION;
    headers["mcp-method"] = options.method;
    if (typeof params.name === "string") headers["mcp-name"] = params.name;
    if (typeof params.uri === "string") headers["mcp-name"] = params.uri;
  } else if (options.method !== "initialize") {
    headers["mcp-protocol-version"] = LEGACY_VERSION;
  }
  if (options.token !== null) headers.authorization = `Bearer ${options.token}`;
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === null) delete headers[name];
    else headers[name] = value;
  }
  const httpMethod = options.httpMethod ?? "POST";
  const body = httpMethod === "POST" ? JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: options.method, params }) : undefined;
  return new Request("http://localhost/api/mcp", { method: httpMethod, headers, body });
}

export async function readMcpResponse(response: Response): Promise<McpCallResult> {
  const text = await response.text();
  let body: unknown = text;
  const data = (response.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).pop()
    : text;
  try {
    if (data) body = JSON.parse(data);
  } catch {
    // Not JSON: the caller reads the text.
  }
  return { status: response.status, headers: response.headers, body };
}

export async function callMcp(handler: Handler, options: McpCallOptions): Promise<McpCallResult> {
  return readMcpResponse(await handler(mcpRequest(options)));
}

/** A legacy client opens with `initialize`; these are its params. */
export const legacyInitialize = { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: { name: "test-client", version: "1" } };
