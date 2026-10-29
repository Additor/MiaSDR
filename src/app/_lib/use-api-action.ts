import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { orThrow, type ActionResult } from "./api-action";

/**
 * The busy state of a screen's change actions (docs/decisions.md, "Change actions"). `run(key, work, tag)` marks `key`
 * busy until `work` settles and drops any call on the same key while it runs, so a double click sends one request; other
 * keys run side by side. A key names what the action changes: actions that would conflict on one item (Retry and Dismiss
 * of a row, Resend and Revoke of an invitation) share the item's key, and `tag` says which of them runs, for its label.
 * Two clicks land before the busy render, so the guard is a ref. A dropped call resolves to null. `isBusy(key)` disables
 * the item's controls, `busyTag(key)` labels the one that runs.
 */
export function useApiAction<K extends string = string>() {
  const running = useRef(new Map<K, string | null>());
  const [busy, setBusy] = useState<ReadonlyMap<K, string | null>>(() => new Map());
  const run = useCallback(async <T>(key: K, work: () => Promise<T>, tag: string | null = null): Promise<T | null> => {
    if (running.current.has(key)) return null;
    running.current.set(key, tag);
    setBusy(new Map(running.current));
    try {
      return await work();
    } finally {
      running.current.delete(key);
      setBusy(new Map(running.current));
    }
  }, []);
  const isBusy = useCallback((key: K) => busy.has(key), [busy]);
  const busyTag = useCallback((key: K) => busy.get(key) ?? null, [busy]);
  return { run, isBusy, busyTag };
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
