"use client";

import { PencilIcon } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/components/ui/utils";

/** What a save answers: null when it went through, else the reason to show under the field. */
export type RenameResult = string | null;

/** The longest name the grid and the rest of the app store. */
export const MAX_NAME = 200;

/** How an edit ended: from the keyboard (Enter or Escape), or by leaving the field for something else. */
export type RenameEnd = "key" | "blur";

/**
 * The field a name turns into while you edit it, at the size of the text it replaces. Enter saves and keeps the field
 * open on an empty name; leaving the field saves too, and drops an empty or unchanged name. Escape cancels. A failed
 * save keeps what you typed with the reason under it; leaving the field again after that gives up and restores the name.
 * `onDone` says how the edit ended, so the caller moves focus back only after a key, never away from a click elsewhere.
 */
export function NameInput({ value, label, onSave, onDone, className }: { value: string; label: string; onSave: (name: string) => Promise<RenameResult>; onDone: (saved: boolean, end: RenameEnd) => void; className?: string }) {
  const errorId = useId();
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const [pending, setPending] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // The text a save last refused: leaving the field with it still there gives up instead of asking again.
  const refused = useRef<string | null>(null);
  const done = useRef(false);

  const finish = useCallback(
    (saved: boolean, end: RenameEnd) => {
      if (done.current) return;
      done.current = true;
      onDone(saved, end);
    },
    [onDone],
  );

  // The reason floats under the field from the page's top layer, so a tab strip that scrolls or a title that truncates
  // cannot clip it. It follows the field while the page scrolls or resizes.
  useEffect(() => {
    if (!error) return;
    const measure = () => {
      const box = input.current?.getBoundingClientRect();
      if (box) setPlace({ top: box.bottom + 4, left: box.left });
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [error]);

  async function commit(end: RenameEnd) {
    if (pending || done.current) return;
    const name = text.trim();
    if (name === value.trim()) return finish(false, end);
    if (!name) {
      if (end === "key") return setError("Give it a name.");
      return finish(false, end);
    }
    if (end === "blur" && refused.current === name) return finish(false, end);
    setPending(true);
    setError(null);
    const problem = await onSave(name);
    setPending(false);
    if (!problem) return finish(true, end);
    refused.current = name;
    setError(problem);
    // The field stays focusable while it saves (read-only, not disabled), so focus can come straight back to it.
    input.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // The field sits inside rows and tab strips that read these keys; it keeps them.
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      void commit("key");
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false, "key");
    }
  }

  return (
    <span className="inline-flex min-w-0 max-w-full">
      <input
        ref={input}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        autoFocus
        maxLength={MAX_NAME}
        value={text}
        readOnly={pending}
        aria-busy={pending || undefined}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => void commit("blur")}
        className={cn(
          "h-7 max-w-full min-w-24 rounded-md border border-input bg-background px-1.5 [field-sizing:content] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 read-only:opacity-60 aria-invalid:border-destructive aria-invalid:ring-destructive/20",
          className,
        )}
      />
      {error &&
        place &&
        createPortal(
          <span id={errorId} role="alert" style={{ top: place.top, left: place.left }} className="fixed z-50 w-max max-w-72 rounded-lg bg-popover px-2 py-1 text-xs font-normal text-destructive shadow-md ring-1 ring-foreground/10">
            {error}
          </span>,
          document.body,
        )}
    </span>
  );
}

/**
 * A name you rename where you read it, such as a page title. At rest it is the text; hover or focus shows a muted
 * ground and a pencil (always shown on a touch screen). A click, Enter or F2 turns it into `NameInput`, and focus comes
 * back to the name when the edit ends. A polite status line announces the new name.
 */
export function EditableTitle({ value, label, onSave, as: Tag = "h1", className }: { value: string; label: string; onSave: (name: string) => Promise<RenameResult>; as?: "h1" | "p" | "span"; className?: string }) {
  const hintId = useId();
  const [editing, setEditing] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [returnFocus, setReturnFocus] = useState(false);
  const button = useCallback(
    (el: HTMLButtonElement | null) => {
      if (returnFocus) el?.focus();
    },
    [returnFocus],
  );

  return (
    <>
      <Tag className={cn("min-w-0 text-sm font-medium", className)}>
        {editing ? (
          <NameInput
            value={value}
            label={label}
            onSave={async (name) => {
              const problem = await onSave(name);
              if (!problem) setAnnounce(`Renamed to ${name}`);
              return problem;
            }}
            onDone={(_saved, end) => {
              setEditing(false);
              setReturnFocus(end === "key");
            }}
            className="-ml-1.5"
          />
        ) : (
          <button
            ref={button}
            type="button"
            aria-describedby={hintId}
            onClick={() => setEditing(true)}
            onKeyDown={(e) => {
              if (e.key === "F2") {
                e.preventDefault();
                setEditing(true);
              }
            }}
            className="group/title -ml-1.5 inline-flex h-7 max-w-full min-w-0 cursor-text items-center gap-1.5 rounded-md px-1.5 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring max-sm:h-11"
          >
            <span className="truncate">{value}</span>
            <PencilIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover/title:opacity-100 group-focus-visible/title:opacity-100 [@media(hover:none)]:opacity-100" />
          </button>
        )}
      </Tag>
      {/* Outside the heading, so the heading reads as the name alone. */}
      <span id={hintId} className="sr-only">
        Press Enter or F2 to rename
      </span>
      <span role="status" className="sr-only">
        {announce}
      </span>
    </>
  );
}
