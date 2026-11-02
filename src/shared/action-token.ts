import { createHash } from "node:crypto";
import { ConflictError } from "./errors";

/**
 * The token a preview hands out and the action checks: what the agent saw. It catches a change in between, not a
 * forgery, so every rule still runs when the action does. The token carries the state, so an action can take back what
 * the preview read, such as the counts a contact delete confirms or a deal's version. No I/O.
 */
const VERSION = "at1";

const encode = (purpose: string, target: string, state: unknown) => Buffer.from(JSON.stringify([purpose, target, state])).toString("base64url");

export const actionToken = (purpose: string, target: string, state: unknown): string => `${VERSION}.${encode(purpose, target, state)}`;

/** The state in a token made for this purpose and target, or null for any other token. */
export function readActionToken<T>(token: string, purpose: string, target: string): T | null {
  const [version, body, extra] = token.split(".");
  if (version !== VERSION || !body || extra !== undefined) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== purpose || parsed[1] !== target) return null;
    return parsed[2] as T;
  } catch {
    return null;
  }
}

/** Whether a token still describes `state`. */
export const actionTokenMatches = (token: string, purpose: string, target: string, state: unknown): boolean => token === actionToken(purpose, target, state);

/** A short stand-in for state too large to carry, such as a list of rows. */
export const stateDigest = (state: unknown): string => createHash("sha256").update(JSON.stringify(state)).digest("base64url").slice(0, 32);

export const actionTokenStale = () => new ConflictError("This changed since the preview. Run the preview again and check the new answer.", { code: "action_token_stale" });
