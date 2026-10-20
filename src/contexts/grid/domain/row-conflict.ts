import { ConflictError } from "@/shared/errors";

export interface RowConflict {
  rowId: string;
  expectedVersion: number;
  /** Null when the row no longer exists. */
  currentVersion: number | null;
  /** The row as it stands now, so a client can merge or retry. Null when it was deleted. */
  cells: Record<string, unknown> | null;
}

/** A cell edit named a row version that is no longer the current one. Nothing was written. */
export class RowConflictError extends ConflictError {
  constructor(readonly conflicts: RowConflict[]) {
    super("Some rows changed since you loaded them. Review the new values and try again.", { conflicts });
  }
}
