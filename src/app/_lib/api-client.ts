/**
 * The browser side of our JSON API: `callApi` reads the error shape the route wrappers in `./api.ts` write (`error`,
 * `issues`, the whole body as `details`). Client components import it; route handlers import `./api.ts`.
 */
export interface ApiResult<T> {
  ok: boolean;
  /** The HTTP status, or 0 when the request never got an answer. */
  status: number;
  data: T | null;
  /** A message a person can read. */
  error: string | null;
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
    const data = (await response.json().catch(() => null)) as (T & { error?: unknown; issues?: unknown }) | null;
    if (!response.ok) {
      const details = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
      const error = typeof data?.error === "string" ? data.error : response.status === 401 ? "Your session expired. Sign in again." : "Something went wrong. Try again.";
      return { ok: false, status: response.status, data: null, error, issues: Array.isArray(data?.issues) ? (data.issues as ApiResult<T>["issues"]) : [], details };
    }
    return { ok: true, status: response.status, data, error: null, issues: [], details: null };
  } catch (error) {
    const cancelled = error instanceof DOMException && error.name === "AbortError";
    return { ok: false, status: 0, data: null, error: cancelled ? "Cancelled." : "Could not reach the server.", issues: [], details: null };
  }
}
