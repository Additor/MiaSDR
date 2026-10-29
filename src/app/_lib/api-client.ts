/**
 * The browser side of our JSON API: `callApi` reads the error body of `./api-errors.ts` (`error`, `code`, `issues`, the
 * whole body as `details`). Client components import it; route handlers import `./api.ts`.
 */
import type { ApiErrorCode } from "./api-errors";

/**
 * The codes whose words the browser owns (docs/decisions.md, "API errors and contract types"). For these `callApi`
 * answers its own sentence; a screen that knows who or what the refusal is about passes a subject through `apiMessage`.
 * A screen with a more specific next step, such as a deal page that reloads itself on `stale_version`, says its own.
 * Every other code shows the server's `error`, which can carry data the browser cannot rebuild (`${count} deals`).
 */
const CLIENT_MESSAGES = {
  unauthenticated: () => "Your session expired. Sign in again.",
  try_again: (subject?: string) => `MiaSDR is saving another change${subject ? ` to ${subject}` : ""}. Try again in a moment.`,
} satisfies Record<string, (subject?: string) => string>;

export type ClientCode = keyof typeof CLIENT_MESSAGES;

const isClientCode = (code: string | null): code is ClientCode => code !== null && Object.hasOwn(CLIENT_MESSAGES, code);

/** The browser's sentence for one of its codes, about `subject` ("Ada Lovelace", "this deal") when one is given. */
export function apiMessage(code: ClientCode, subject?: string): string {
  return CLIENT_MESSAGES[code](subject);
}

export interface ApiResult<T> {
  ok: boolean;
  /** The HTTP status, or 0 when the request never got an answer. */
  status: number;
  data: T | null;
  /** A message a person can read. */
  error: string | null;
  /** The refusal's stable code (`not_found`, `try_again`...). Null on success and when no answer came. */
  code: ApiErrorCode | null;
  /** Per-field problems when the server returned a list (422 and 400). */
  issues: Array<{ step?: number | null; message: string }>;
  /** The whole error body, for a refusal that carries data (a 409 `code` with a `dealId` or a `version`). Null on success. */
  details: Record<string, unknown> | null;
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Calls our JSON API and always returns a result: the UI decides what to show, nothing throws. A `FormData` body goes
 * out as multipart, anything else as JSON. An aborted call answers "Cancelled." with status 0.
 */
export async function callApi<T = unknown>(url: string, method: Method, body?: unknown, init?: { signal?: AbortSignal }): Promise<ApiResult<T>> {
  try {
    const form = body instanceof FormData;
    const response = await fetch(url, {
      method,
      headers: body === undefined || form ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : form ? body : JSON.stringify(body),
      signal: init?.signal,
    });
    const data = (await response.json().catch(() => null)) as (T & { error?: unknown; issues?: unknown; code?: unknown }) | null;
    if (!response.ok) {
      const details = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
      // A 401 without a body comes from a layer in front of the app; it means the same as `unauthenticated`.
      const code = typeof data?.code === "string" ? data.code : response.status === 401 && typeof data?.error !== "string" ? "unauthenticated" : null;
      const error = isClientCode(code) ? apiMessage(code) : typeof data?.error === "string" ? data.error : "Something went wrong. Try again.";
      return { ok: false, status: response.status, data: null, error, code, issues: Array.isArray(data?.issues) ? (data.issues as ApiResult<T>["issues"]) : [], details };
    }
    return { ok: true, status: response.status, data, error: null, code: null, issues: [], details: null };
  } catch (error) {
    const cancelled = error instanceof DOMException && error.name === "AbortError";
    return { ok: false, status: 0, data: null, error: cancelled ? "Cancelled." : "Could not reach the server.", code: null, issues: [], details: null };
  }
}
