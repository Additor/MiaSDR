/** Browser side calls to /api/grid. Never throws: the caller decides what to show. */

export interface GridResponse<T> {
  ok: boolean;
  status: number;
  data: T | null;
  /** A message a person can read. */
  error: string | null;
  /** The parsed body of a failed answer, for fields such as `conflicts`. */
  failure: Record<string, unknown> | null;
}

export async function gridRequest<T = unknown>(url: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown, init?: { signal?: AbortSignal }): Promise<GridResponse<T>> {
  try {
    const response = await fetch(url, {
      method,
      headers: body === undefined || body instanceof FormData ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      signal: init?.signal,
    });
    const json = (await response.json().catch(() => null)) as (Record<string, unknown> | null);
    if (!response.ok) {
      const issues = Array.isArray(json?.issues) ? (json.issues as Array<{ message?: string }>).map((i) => i.message).filter(Boolean) : [];
      const base = typeof json?.error === "string" ? json.error : response.status === 401 ? "Your session expired. Sign in again." : "Something went wrong. Try again.";
      return { ok: false, status: response.status, data: null, error: issues.length > 0 && issues[0] !== base ? `${base} ${issues.slice(0, 3).join(" ")}` : base, failure: json };
    }
    return { ok: true, status: response.status, data: json as T, error: null, failure: null };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return { ok: false, status: 0, data: null, error: "Cancelled.", failure: null };
    return { ok: false, status: 0, data: null, error: "Could not reach the server.", failure: null };
  }
}

export const gridUrl = {
  folders: "/api/grid/folders",
  workbooks: "/api/grid/workbooks",
  tables: "/api/grid/tables",
  table: (id: string) => `/api/grid/tables/${id}`,
  view: (id: string) => `/api/grid/tables/${id}/view`,
  sub: (id: string, path: string) => `/api/grid/tables/${id}/${path}`,
};
