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
 * Enter in a text field of the body presses the confirm, as a form submit would; a textarea, an IME composition and a control
 * that handles Enter itself (a combobox picking an item) keep the key.
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
  onConfirm: () => unknown;
  children?: ReactNode;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Two quick presses of Enter run before the pending render lands, so the guard is a ref.
  const running = useRef(false);

  function change(next: boolean) {
    if (pending) return;
    if (!next) setError(null);
    onOpenChange(next);
  }

  async function confirm() {
    if (running.current) return;
    setError(null);
    const result = onConfirm();
    if (!(result instanceof Promise)) {
      onOpenChange(false);
      return;
    }
    running.current = true;
    setPending(true);
    try {
      if ((await result) !== false) onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      running.current = false;
      setPending(false);
    }
  }

  function enterConfirms(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Enter" || e.shiftKey || e.defaultPrevented || e.nativeEvent.isComposing) return;
    const target = e.target;
    if (!(target instanceof HTMLInputElement) || NOT_TEXT.has(target.type)) return;
    e.preventDefault();
    if (!pending && !confirmDisabled) void confirm();
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent showCloseButton={!pending} className={cn("flex max-h-[calc(100dvh-2rem)] flex-col", className)}>
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
            <Button variant="ghost" disabled={pending} onClick={back.onClick} className="sm:mr-auto">
              {back.label}
            </Button>
          )}
          <Button variant="outline" disabled={pending} onClick={() => change(false)}>
            {cancelLabel}
          </Button>
          <Button variant={destructive ? "destructive" : "default"} disabled={pending || confirmDisabled} onClick={() => void confirm()}>
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Inputs where Enter is not a submit. */
const NOT_TEXT = new Set(["checkbox", "radio", "button", "submit", "reset", "file", "range", "color"]);
