"use client";

import { useEffect, useRef, useState } from "react";
import { formatDay, parseDay } from "@/components/shell/day";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { effectiveColumnType } from "@/contexts/grid/domain/column-types";
import { editorText, parseEditorText, selectOptions } from "../_lib/view/format";
import type { GridColumn } from "../_lib/data/types";

export type CommitMove = "down" | "right" | "left" | "none";

interface Props {
  column: GridColumn;
  value: unknown;
  /** A character the person typed to open the editor. It replaces the value. */
  initial: string | null;
  label: string;
  onCommit: (value: string | null, move: CommitMove) => void;
  onCancel: () => void;
}

const FIELD = "h-full w-full min-w-0 bg-background px-2 text-sm outline-none";

/**
 * The in-cell editor for one static column type. Enter commits and moves down, Tab moves sideways, Escape discards. A
 * select column opens the app's Select on the cell: a pick commits, and Escape, Tab or a click outside discards.
 */
export function CellEditor({ column, value, initial, label, onCommit, onCancel }: Props) {
  const type = effectiveColumnType(column);
  const done = useRef(false);
  const finish = (next: string | null, move: CommitMove) => {
    if (done.current) return;
    done.current = true;
    onCommit(next, move);
  };
  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };

  if (type === "select") {
    return <SelectEditor column={column} value={value} label={label} finish={finish} cancel={cancel} />;
  }

  return (
    <TextEditor
      label={label}
      initial={initial !== null ? initial : editorText(value)}
      selectAll={initial === null}
      calendar={type === "date"}
      inputMode={type === "number" || type === "currency" ? "decimal" : undefined}
      finish={finish}
      cancel={cancel}
    />
  );
}

/**
 * A text field over the cell. A date column types yyyy-MM-dd as text and shows a calendar under the cell: a click on a
 * day commits it, and the field keeps focus, so the keys work as in any other cell.
 */
function TextEditor({
  label,
  initial,
  selectAll,
  calendar,
  inputMode,
  finish,
  cancel,
}: {
  label: string;
  initial: string;
  selectAll: boolean;
  calendar: boolean;
  inputMode?: "decimal";
  finish: (value: string | null, move: CommitMove) => void;
  cancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const [month, setMonth] = useState(() => parseDay(initial) ?? new Date());
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (selectAll) el.select();
    else el.setSelectionRange(el.value.length, el.value.length);
  }, [selectAll]);
  const day = calendar ? parseDay(text.trim()) : null;
  const field = (
    <input
      ref={ref}
      className={FIELD}
      type="text"
      inputMode={inputMode}
      placeholder={calendar ? "yyyy-MM-dd" : undefined}
      aria-label={label}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const typed = calendar ? parseDay(e.target.value.trim()) : null;
        if (typed) setMonth(typed);
      }}
      onBlur={() => finish(parseEditorText(text), "none")}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(parseEditorText(text), e.shiftKey ? "none" : "down");
        } else if (e.key === "Tab") {
          e.preventDefault();
          finish(parseEditorText(text), e.shiftKey ? "left" : "right");
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
        e.stopPropagation();
      }}
    />
  );
  if (!calendar) return field;
  return (
    <>
      {field}
      <Popover open>
        <PopoverContent
          anchor={ref}
          aria-label={label}
          initialFocus={false}
          finalFocus={false}
          className="w-auto p-0"
          // The field keeps focus while you click the calendar, so leaving the field still commits it.
          onMouseDown={(e) => e.preventDefault()}
        >
          <Calendar mode="single" required selected={day ?? undefined} month={month} onMonthChange={setMonth} onSelect={(picked: Date) => finish(formatDay(picked), "none")} />
        </PopoverContent>
      </Popover>
    </>
  );
}

const EMPTY = "\u0000empty";

function SelectEditor({
  column,
  value,
  label,
  finish,
  cancel,
}: {
  column: GridColumn;
  value: unknown;
  label: string;
  finish: (value: string | null, move: CommitMove) => void;
  cancel: () => void;
}) {
  const options = selectOptions(column);
  const current = typeof value === "string" ? value : "";
  const known = options.some((o) => o.value === current);
  const items = [{ value: EMPTY, label: "No value" }, ...(!known && current !== "" ? [{ value: current, label: current }] : []), ...options];
  return (
    <Select
      items={items}
      value={current === "" ? EMPTY : current}
      defaultOpen
      onValueChange={(next) => next !== null && finish(next === EMPTY ? null : next, "none")}
      // Escape, Tab or a click outside closes the list without a pick, which cancels the edit.
      onOpenChange={(open) => !open && cancel()}
    >
      <SelectTrigger aria-label={label} className="h-full w-full rounded-none border-0 bg-background px-2 focus-visible:ring-0 dark:bg-background">
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} align="start">
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value} className={item.value === EMPTY ? "text-muted-foreground" : undefined}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
