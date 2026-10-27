/**
 * The steps a Change type submit still has to take. A type change that went through and a stop that failed leave the dialog
 * open with the error; the retry then only stops contact, since the type already changed and its version moved on.
 */
export function submitSteps(changedTo: string | null, chosenId: string, mode: "change" | "stop"): { change: boolean; stop: boolean } {
  return { change: changedTo !== chosenId, stop: mode === "stop" };
}
