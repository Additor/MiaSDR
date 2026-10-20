export interface CellChange {
  rowId: string;
  columnKey: string;
  previous: unknown;
  value: unknown;
}

export interface CellsChangedEvent {
  organizationId: string;
  tableId: string;
  userId: string;
  changes: CellChange[];
}

/** What a listener did with the change: cells it queued and cells its limits held back. */
export interface CellsChangedOutcome {
  queued: number;
  skippedByCap: number;
}

/** Returns how many cells it queued, if it queues any (a bare number counts as queued). Errors are logged and never fail the edit, which is already saved. */
export type CellsChangedListener = (event: CellsChangedEvent) => Promise<number | CellsChangedOutcome | void>;

const listeners: CellsChangedListener[] = [];

/**
 * Lets the module that runs formulas and enrichments react to edits (for example by queueing the
 * columns that read the edited cell). Register once at startup. Registering the same function twice is a no-op.
 */
export function registerCellsChangedListener(listener: CellsChangedListener): void {
  if (!listeners.includes(listener)) listeners.push(listener);
}

export async function notifyCellsChanged(event: CellsChangedEvent): Promise<CellsChangedOutcome> {
  const total: CellsChangedOutcome = { queued: 0, skippedByCap: 0 };
  if (event.changes.length === 0) return total;
  for (const listener of listeners) {
    try {
      const result = await listener(event);
      if (typeof result === "number") total.queued += result;
      else if (result) {
        total.queued += result.queued;
        total.skippedByCap += result.skippedByCap;
      }
    } catch (error) {
      console.error("[grid] a cell change listener failed:", error instanceof Error ? error.message : error);
    }
  }
  return total;
}
