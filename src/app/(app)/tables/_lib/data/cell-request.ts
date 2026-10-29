"use client";

import { createContext, useContext } from "react";
import { gridRequest, type GridResponse } from "./client";

/** `gridRequest` for a request about the open table, sent once queued cell edits have landed (`useGridTable`). */
export type CellRequest = <T = unknown>(url: string, method: Parameters<typeof gridRequest>[1], body?: unknown) => Promise<GridResponse<T>>;

/** Why a request waits: the conflict dialog holds edits that must be retried or dropped first. */
export const RESOLVE_CONFLICT_FIRST = "Resolve the edit conflict first.";

/** The open table's `cellRequest`. `TableWorkspace` provides it to every dialog and panel it renders. */
export const CellRequestContext = createContext<CellRequest | null>(null);

/**
 * The open table's `cellRequest`. Outside a `TableWorkspace` (an import that starts a new workbook from the browser)
 * no table is open and no edits are queued, so the request goes out as it is.
 */
export function useCellRequest(): CellRequest {
  return useContext(CellRequestContext) ?? gridRequest;
}
