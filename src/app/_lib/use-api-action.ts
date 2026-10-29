import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { orThrow, type ActionResult } from "./api-action";

/**
 * The busy state of a screen's change actions (docs/decisions.md, "Change actions"). `run(key, work)` marks `key` busy until
 * `work` settles and drops a second call while one runs, so a double click or a second row's button sends nothing. Two
 * clicks land before the busy render, so the guard is a ref. A dropped call resolves to null.
 */
export function useApiAction<K extends string = string>() {
  const [busy, setBusy] = useState<K | null>(null);
  const running = useRef(false);
  const run = useCallback(async <T>(key: K, work: () => Promise<T>): Promise<T | null> => {
    if (running.current) return null;
    running.current = true;
    setBusy(key);
    try {
      return await work();
    } finally {
      running.current = false;
      setBusy(null);
    }
  }, []);
  return { busy, run };
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
