/** Browser side calls to /api/grid. Never throws: the caller decides what to show. */

import { callApi } from "@/app/_lib/api-client";

export interface GridResponse<T> {
  ok: boolean;
  status: number;
  data: T | null;
  /** A message a person can read. */
  error: string | null;
  /** The parsed body of a failed answer, for fields such as `conflicts`. */
  failure: Record<string, unknown> | null;
}

/** `callApi` with the answer Tables reads: the first issues joined into `error`, the failed body as `failure`. */
export async function gridRequest<T = unknown>(url: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown, init?: { signal?: AbortSignal }): Promise<GridResponse<T>> {
  const res = await callApi<T>(url, method, body, init);
  if (res.ok) return { ok: true, status: res.status, data: res.data, error: null, failure: null };
  const base = res.error ?? "Something went wrong. Try again.";
  const issues = res.issues.map((i) => i.message).filter(Boolean);
  return { ok: false, status: res.status, data: null, error: issues.length > 0 && issues[0] !== base ? `${base} ${issues.slice(0, 3).join(" ")}` : base, failure: res.details };
}

export const gridUrl = {
  folders: "/api/grid/folders",
  workbooks: "/api/grid/workbooks",
  tables: "/api/grid/tables",
  table: (id: string) => `/api/grid/tables/${id}`,
  view: (id: string) => `/api/grid/tables/${id}/view`,
  sub: (id: string, path: string) => `/api/grid/tables/${id}/${path}`,
};
