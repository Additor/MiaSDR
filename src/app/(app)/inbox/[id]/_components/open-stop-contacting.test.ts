import { afterEach, describe, expect, it, vi } from "vitest";
import { onOpenStopContacting, openStopContacting } from "./open-stop-contacting";

describe("openStopContacting", () => {
  afterEach(() => vi.useRealTimers());

  it("opens a dialog that listens", () => {
    const open = vi.fn();
    const stop = onOpenStopContacting(open);
    openStopContacting();
    expect(open).toHaveBeenCalledTimes(1);
    stop();
  });

  it("keeps a request made before the dialog hydrated, and answers it once", () => {
    openStopContacting();
    const open = vi.fn();
    const stop = onOpenStopContacting(open);
    expect(open).toHaveBeenCalledTimes(1);
    stop();
    const next = vi.fn();
    const stopNext = onOpenStopContacting(next);
    expect(next).not.toHaveBeenCalled();
    stopNext();
  });

  it("drops a request the person made long ago", () => {
    vi.useFakeTimers();
    openStopContacting();
    vi.advanceTimersByTime(5_001);
    const open = vi.fn();
    const stop = onOpenStopContacting(open);
    expect(open).not.toHaveBeenCalled();
    stop();
  });
});
