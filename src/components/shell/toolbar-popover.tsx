"use client";

import type { LucideIcon } from "lucide-react";
import { createContext, useContext, useRef, useState, type ReactNode, type Ref } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/components/ui/utils";

const WIDTH = { fields: "w-[30rem]", builder: "w-[40rem]" } as const;

/**
 * On a phone the popup leaves its trigger and sits at the bottom edge at full width. The positioner's inline place gives
 * way to these classes.
 */
const PHONE_SHEET = "max-sm:!fixed max-sm:!inset-x-0 max-sm:!top-auto max-sm:!bottom-0 max-sm:!transform-none";

const Close = createContext<() => void>(() => {});

/** Closes the popover without throwing the draft away, for a caller whose Apply saved it. */
export const useCloseToolbarPopover = () => useContext(Close);

/**
 * The popover behind a toolbar button that edits a draft: Filters on a list, Filter and Sort on a table. The trigger
 * shows the icon, the label and how many are in force. Closing by Escape, a click outside or the trigger calls
 * `onDiscard`; Apply closes through `useCloseToolbarPopover`, or by leaving the page when it submits a form.
 *
 * `inline` keeps the popup in the DOM next to the trigger while it is closed, so a form around the toolbar still
 * submits the fields in it.
 */
export function ToolbarPopover({
  icon: Icon,
  label,
  count,
  size = "fields",
  compact = false,
  inline = false,
  onDiscard,
  testId,
  children,
}: {
  icon: LucideIcon;
  label: string;
  /** How many are in force. Zero shows no count. */
  count: number;
  size?: keyof typeof WIDTH;
  /** On a phone the trigger shows the icon and the count, without the label. */
  compact?: boolean;
  inline?: boolean;
  onDiscard?: () => void;
  testId?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLSpanElement>(null);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) onDiscard?.();
        setOpen(next);
      }}
    >
      <PopoverTrigger render={<Button type="button" variant="outline" size="sm" touch data-testid={testId} />}>
        <Icon aria-hidden />
        <span className={cn(compact && "max-sm:sr-only")}>{label}</span>
        {count > 0 && (
          // A muted number, as on the scope segments: the chips under the toolbar name what is in use.
          <span className="text-muted-foreground tabular-nums">
            {count}
            <span className="sr-only"> in use</span>
          </span>
        )}
      </PopoverTrigger>
      {inline && <span ref={container} className="contents" />}
      <PopoverContent
        aria-label={label}
        container={inline ? container : undefined}
        keepMounted={inline}
        positionMethod="fixed"
        positionerClassName={PHONE_SHEET}
        className={cn("flex max-w-[calc(100vw-2rem)] flex-col", WIDTH[size], "max-sm:max-h-[85svh] max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none")}
      >
        <Close.Provider value={() => setOpen(false)}>{children}</Close.Provider>
      </PopoverContent>
    </Popover>
  );
}

/** The scrolling part of the popup. Sections inside it stack with a hairline between them. */
export function ToolbarPopoverBody({ children, ref }: { children: ReactNode; ref?: Ref<HTMLDivElement> }) {
  return (
    <div ref={ref} className="grid min-h-0 flex-1 content-start gap-inset overflow-y-auto overscroll-contain p-3 max-sm:p-4">
      {children}
    </div>
  );
}

/**
 * The footer that stays in view: Reset empties the draft and leaves the page alone, Apply commits it. A form's Apply is a
 * submit button; otherwise `onApply` runs. A failed Apply shows its reason above the buttons.
 */
export function ToolbarPopoverFooter({ onReset, onApply, busy = false, error }: { onReset: () => void; onApply?: () => void; busy?: boolean; error?: string | null }) {
  return (
    <div className="grid gap-2 border-t p-3 max-sm:p-4">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onReset} disabled={busy} touch>
          Reset
        </Button>
        <Button type={onApply ? "button" : "submit"} size="sm" onClick={onApply} disabled={busy} touch>
          {busy ? "Applying…" : "Apply"}
        </Button>
      </div>
    </div>
  );
}
