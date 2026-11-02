let listener: (() => void) | null = null;
let askedAt: number | null = null;

/** How long a request waits for the dialog to hydrate. Past this the person has moved on, and opening would surprise them. */
const WAIT_MS = 5_000;

/**
 * Opens Stop contacting from elsewhere on the thread, such as Review stop request on the type line. The two hydrate
 * separately, so the button can work before the dialog does; the request then waits for the dialog instead of being lost.
 */
export function openStopContacting() {
  if (listener) listener();
  else askedAt = Date.now();
}

/** Listens for `openStopContacting`, and answers a request made while nothing listened. Returns the cleanup. */
export function onOpenStopContacting(open: () => void) {
  listener = open;
  if (askedAt !== null && Date.now() - askedAt <= WAIT_MS) open();
  askedAt = null;
  return () => {
    if (listener === open) listener = null;
  };
}
