"use client";

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/components/ui/utils";

/**
 * Controlled confirmation. Name the object in the title and the consequence in the description; the button repeats the action.
 * A synchronous `onConfirm` closes the dialog first and then runs. When `onConfirm` returns a promise, the dialog stays
 * open with both buttons disabled and the button reading `pendingLabel`, closes when the promise resolves, and shows the
 * thrown message in an alert line when it rejects. A promise that resolves to `false` keeps the dialog open, for an outcome
 * the caller renders as data in `children` (a link, a report). `children` render under the description for extra detail or inputs.
 * The panel never grows past the viewport: the header and the footer stay in place and the body between them scrolls, so the
 * confirm button stays on screen at 390x844. `back` adds a ghost button at the start of the footer for a dialog with two steps.
 * Enter in a text field of the body presses the confirm, as a form submit would; a textarea, an IME composition, a combobox and
 * a control that handles Enter itself keep the key. `secondary` adds an outline action before the confirm for
 * a dialog with two ways forward ("Only change the type" beside "Stop contacting"); it runs like the confirm, with its own
 * pending label, and Enter still presses the confirm.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  pendingLabel = "Working…",
  destructive = false,
  confirmDisabled = false,
  className,
  back,
  secondary,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  /** Name the safe choice when "Cancel" would read as the destructive one, such as "Keep follow-ups" under a "Stop follow-ups" button. */
  cancelLabel?: string;
  pendingLabel?: string;
  destructive?: boolean;
  /** Disables the confirm button, for a form in `children` that is not ready. */
  confirmDisabled?: boolean;
  /** Extra classes for the dialog panel, such as a wider `sm:max-w-md` for a form. */
  className?: string;
  /** The way back to the first step of a two-step dialog, such as "Back" from a preview to its form. */
  back?: { label: string; onClick: () => void };
  /** A second way forward, drawn as an outline button before the confirm. */
  secondary?: { label: string; pendingLabel: string; disabled?: boolean; onConfirm: () => unknown };
  onConfirm: () => unknown;
  children?: ReactNode;
}) {
  /** Which button runs: the confirm or the secondary action. */
  const [pending, setPending] = useState<"confirm" | "secondary" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Two quick presses of Enter run before the pending render lands, so the guard is a ref.
  const running = useRef(false);

  function change(next: boolean) {
    if (pending !== null) return;
    if (!next) setError(null);
    onOpenChange(next);
  }

  async function confirm(which: "confirm" | "secondary" = "confirm") {
    if (running.current) return;
    setError(null);
    const result = which === "confirm" ? onConfirm() : secondary?.onConfirm();
    if (!(result instanceof Promise)) {
      onOpenChange(false);
      return;
    }
    running.current = true;
    setPending(which);
    try {
      if ((await result) !== false) onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      running.current = false;
      setPending(null);
    }
  }

  function enterConfirms(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Enter" || e.shiftKey || e.defaultPrevented || e.nativeEvent.isComposing) return;
    const target = e.target;
    if (!(target instanceof HTMLInputElement) || NOT_TEXT.has(target.type)) return;
    // A combobox keeps Enter even with no item highlighted. Base UI lets that key through to close the list, and a confirm
    // there would submit the earlier pick while the person still searches for another.
    if (target.getAttribute("role") === "combobox") return;
    e.preventDefault();
    if (pending === null && !confirmDisabled) void confirm();
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent showCloseButton={pending === null} className={cn("flex max-h-[calc(100dvh-2rem)] flex-col", className)}>
        <DialogHeader className="shrink-0">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {(children || error) && (
          // The padding keeps focus rings inside the scroll area, which clips what overflows it; the negative margins keep the spacing.
          <div onKeyDown={enterConfirms} className="-mx-4 -my-1 grid min-h-0 gap-4 overflow-y-auto px-4 py-1">
            {children}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
        )}
        <DialogFooter className="shrink-0">
          {back && (
            <Button variant="ghost" disabled={pending !== null} onClick={back.onClick} className="sm:mr-auto">
              {back.label}
            </Button>
          )}
          <Button variant="outline" disabled={pending !== null} onClick={() => change(false)}>
            {cancelLabel}
          </Button>
          {secondary && (
            <Button variant="outline" disabled={pending !== null || secondary.disabled} onClick={() => void confirm("secondary")}>
              {pending === "secondary" ? secondary.pendingLabel : secondary.label}
            </Button>
          )}
          <Button variant={destructive ? "destructive" : "default"} disabled={pending !== null || confirmDisabled} onClick={() => void confirm()}>
            {pending === "confirm" ? pendingLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Inputs where Enter is not a submit. */
const NOT_TEXT = new Set(["checkbox", "radio", "button", "submit", "reset", "file", "range", "color"]);
