/**
 * The browser side of our JSON API: `callApi` reads the error shape the route wrappers in `./api.ts` write (`error`,
 * `issues`, the whole body as `details`). Client components import it; route handlers import `./api.ts`.
 */
export interface ApiResult<T> {
  ok: boolean;
  data: T | null;
  /** A message a person can read. */
  error: string | null;
  /** Per-field problems when the server returned a list (422 and 400). */
  issues: Array<{ step?: number | null; message: string }>;
  /** The whole error body, for a refusal that carries data (a 409 `code` with a `dealId` or a `version`). Null on success. */
  details: Record<string, unknown> | null;
}

/** Calls our JSON API and always returns a result: the UI decides what to show, nothing throws. */
export async function callApi<T = unknown>(url: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await response.json().catch(() => null)) as (T & { error?: string; issues?: ApiResult<T>["issues"] }) | null;
    if (!response.ok) {
      const details = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
      return { ok: false, data: null, error: data?.error ?? "Something went wrong. Try again.", issues: data?.issues ?? [], details };
    }
    return { ok: true, data, error: null, issues: [], details: null };
  } catch {
    return { ok: false, data: null, error: "Could not reach the server.", issues: [], details: null };
  }
}
