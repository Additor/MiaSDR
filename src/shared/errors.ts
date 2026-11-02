/** Errors the application layer raises. Route handlers map them to HTTP; nothing here knows about HTTP. */
export class NotFoundError extends Error {
  constructor(what = "Not found") {
    super(what);
  }
}

export class ForbiddenError extends Error {
  constructor(message = "You do not have permission to do this.") {
    super(message);
  }
}

export class ConflictError extends Error {
  /** Extra JSON for the response body, such as the rows that changed under an edit. */
  constructor(
    message?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** The request body or upload is larger than the endpoint accepts. Answers 413. */
export class PayloadTooLargeError extends Error {}

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly issues: Array<{ step?: number | null; message: string }> = [],
  ) {
    super(message);
  }
}

export interface Actor {
  userId: string;
  organizationId: string;
  /** Stored role string, possibly comma-separated. */
  role: string;
  /** Set only by the MCP wrapper (`src/app/_lib/mcp.ts`): an agent acts with this person's token. Absent for a person. */
  via?: AgentVia;
}

export interface AgentVia {
  kind: "agent";
  tokenId: string;
  /** The name the person gave the token, shown wherever an agent action is listed. */
  tokenName: string;
  /** The client's own name when the protocol carries one (2026-07-28 requests only). */
  clientName: string | null;
}

/** What an event's `meta` carries when an agent acted: the token's id and name, never its secret. Empty for a person. */
export const viaMeta = (via: AgentVia | undefined): { via?: Omit<AgentVia, "kind"> } =>
  via ? { via: { tokenId: via.tokenId, tokenName: via.tokenName, clientName: via.clientName } } : {};
