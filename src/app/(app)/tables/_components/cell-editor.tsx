"use client";

import { useEffect, useRef, useState } from "react";
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

/** The in-cell editor for one static column type. Enter commits and moves down, Tab moves sideways, Escape discards. */
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

  const text = initial ?? editorText(value);
  const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(text) || (text === "" && initial === null);
  return (
    <TextEditor
      label={label}
      initial={initial !== null ? initial : editorText(value)}
      selectAll={initial === null}
      inputType={type === "date" && isoDate ? "date" : "text"}
      inputMode={type === "number" || type === "currency" ? "decimal" : undefined}
      finish={finish}
      cancel={cancel}
    />
  );
}

function TextEditor({
  label,
  initial,
  selectAll,
  inputType,
  inputMode,
  finish,
  cancel,
}: {
  label: string;
  initial: string;
  selectAll: boolean;
  inputType: string;
  inputMode?: "decimal";
  finish: (value: string | null, move: CommitMove) => void;
  cancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (selectAll) el.select();
    else el.setSelectionRange(el.value.length, el.value.length);
  }, [selectAll]);
  return (
    <input
      ref={ref}
      className={FIELD}
      type={inputType}
      inputMode={inputMode}
      aria-label={label}
      value={text}
      onChange={(e) => setText(e.target.value)}
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
}

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
  const ref = useRef<HTMLSelectElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <select
      ref={ref}
      className={FIELD}
      aria-label={label}
      defaultValue={current}
      onChange={(e) => finish(e.target.value === "" ? null : e.target.value, "none")}
      onBlur={cancel}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        } else if (e.key === "Tab") {
          e.preventDefault();
          cancel();
        }
        e.stopPropagation();
      }}
    >
      <option value="" />
      {!known && current !== "" && <option value={current}>{current}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
