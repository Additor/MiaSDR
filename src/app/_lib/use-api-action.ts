import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { orThrow, type ActionResult } from "./api-action";

/**
 * The busy state of a screen's change actions (docs/decisions.md, "Change actions"). `run(key, work)` marks `key` busy
 * until `work` settles and drops a repeat of the same key while it runs, so a double click sends one request; other keys
 * run side by side. A key names what the action changes (`revoke:<id>`); actions that would conflict share one key.
 * Two clicks land before the busy render, so the guard is a ref. A dropped call resolves to null. `isBusy(key)` disables
 * and labels the control; `anyBusy` is for a control that must wait for every action of the screen.
 */
export function useApiAction<K extends string = string>() {
  const running = useRef(new Set<K>());
  const [busy, setBusy] = useState<ReadonlySet<K>>(() => new Set());
  const run = useCallback(async <T>(key: K, work: () => Promise<T>): Promise<T | null> => {
    if (running.current.has(key)) return null;
    running.current.add(key);
    setBusy(new Set(running.current));
    try {
      return await work();
    } finally {
      running.current.delete(key);
      setBusy(new Set(running.current));
    }
  }, []);
  const isBusy = useCallback((key: K) => busy.has(key), [busy]);
  return { run, isBusy, anyBusy: busy.size > 0 };
}

/** The outcome of an action outside a dialog, as a toast: `success` when it went through, the failure's sentence when not. */
export function toastResult(result: ActionResult<unknown>, success: string): void {
  if (result.ok) toast.success(success);
  else toast.error(result.error);
}

/** The outcome of an action in a ConfirmDialog: `success` as a toast, or the failure's sentence thrown so the dialog stays open with it. */
export function toastOrThrow(result: ActionResult<unknown>, success: string): void {
  orThrow(result);
  toast.success(success);
}
