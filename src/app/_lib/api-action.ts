/**
 * A change a person asks for, sent through `callApi` (docs/decisions.md, "Change actions"). `runApiAction` turns the answer
 * into a success or a failure with one sentence to show, reloads the page's server data when the page is behind, and lets a
 * screen say its own words for a 409 code. `orThrow` hands a failure to ConfirmDialog, which stays open and shows it.
 * `./use-api-action.ts` wires the busy state of a screen.
 */
import type { ApiResult } from "./api-client";
import type { ApiErrorCode } from "./api-errors";

export interface ActionSuccess<T> {
  ok: true;
  status: number;
  data: T;
}

export interface ActionFailure {
  ok: false;
  /** The HTTP status, or 0 when the request never got an answer. */
  status: number;
  /** The sentence the person reads. */
  error: string;
  code: ApiErrorCode | null;
  issues: ApiResult<unknown>["issues"];
  /** The whole error body, for a refusal that carries data (a `version`, a `dealId`). */
  details: Record<string, unknown> | null;
}

export type ActionResult<T> = ActionSuccess<T> | ActionFailure;

export interface ActionOptions {
  /**
   * Reloads the page's server data (`router.refresh`). It runs after a success, and after a 404 or a 409, which say the page
   * shows something the server no longer holds. A 401, a 4xx about the input and an unanswered call leave the page as it is,
   * so the person keeps what they typed.
   */
  refresh?: () => void;
  /**
   * A screen's own step for a 409 code, keyed by the code (`stale_version`, `try_again`). A handler that returns a sentence
   * replaces the failure's `error`; one that returns nothing keeps it.
   */
  onConflict?: Partial<Record<string, (failure: ActionFailure) => string | void>>;
}

const FALLBACK = "Something went wrong. Try again.";
const NO_DATA = "The server sent back nothing to show. Reload the page and try again.";

/**
 * Awaits the call, refreshes when the page is behind, and returns the outcome. It never throws. A success carries
 * `data: T | null`, since a change can answer 204 with no body; a screen that reads the answer passes `expectData: true`,
 * and a success without data then comes back as a failure that says so. The call can be a read sent as POST (a preview), so the sentence does not claim a change.
 */
export function runApiAction<T>(call: Promise<ApiResult<T>>, options: ActionOptions & { expectData: true }): Promise<ActionResult<T>>;
export function runApiAction<T>(call: Promise<ApiResult<T>>, options?: ActionOptions & { expectData?: false }): Promise<ActionResult<T | null>>;
export async function runApiAction<T>(call: Promise<ApiResult<T>>, options: ActionOptions & { expectData?: boolean } = {}): Promise<ActionResult<T | null>> {
  const result = await call;
  if (result.ok) {
    options.refresh?.();
    if (options.expectData && result.data === null) return { ok: false, status: result.status, error: NO_DATA, code: null, issues: [], details: null };
    return { ok: true, status: result.status, data: result.data };
  }
  const failure: ActionFailure = { ok: false, status: result.status, error: result.error ?? FALLBACK, code: result.code, issues: result.issues, details: result.details };
  if (result.status === 409 && result.code) {
    const said = options.onConflict?.[result.code]?.(failure);
    if (typeof said === "string") failure.error = said;
  }
  if (result.status === 404 || result.status === 409) options.refresh?.();
  return failure;
}

/** The data of a success, or the failure's sentence thrown: a ConfirmDialog's `onConfirm` then stays open and shows it. */
export function orThrow<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
