"use client";

import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";
import { callApi } from "@/lib/api-client";

export interface MergeFieldItem {
  token: string;
  label: string;
  group: "standard" | "custom" | "source";
}

export interface UnresolvedToken {
  token: string;
  reason: "empty" | "unknown";
}

const GROUPS: Array<[MergeFieldItem["group"], string]> = [
  ["standard", "Lead fields"],
  ["custom", "Your custom fields"],
  ["source", "Imported source data"],
];

/** Loads the field list once. A failed load leaves the picker empty and the editor usable. */
export function useMergeFields(): MergeFieldItem[] {
  const [fields, setFields] = useState<MergeFieldItem[]>([]);
  useEffect(() => {
    let live = true;
    void callApi<{ fields: MergeFieldItem[] }>("/api/merge-fields", "GET").then((result) => {
      if (live && result.ok && result.data) setFields(result.data.fields);
    });
    return () => {
      live = false;
    };
  }, []);
  return fields;
}

type Spot = { index: number; field: string; start: number; end: number };

/**
 * Remembers the caret of the last edited field so a pick lands there. `getText` and `setText` read and write
 * one field of one step; `idFor` returns the DOM id to refocus.
 */
export function useFieldInsert(opts: {
  getText: (index: number, field: string) => string;
  setText: (index: number, field: string, text: string) => void;
  idFor: (index: number, field: string) => string;
  fallback: () => { index: number; field: string };
}) {
  const spot = useRef<Spot | null>(null);
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  const track = useCallback(
    (index: number, field: string) => (event: SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const el = event.currentTarget;
      spot.current = { index, field, start: el.selectionStart ?? el.value.length, end: el.selectionEnd ?? el.value.length };
    },
    [],
  );

  const insert = useCallback((token: string) => {
    const o = optsRef.current;
    const target = spot.current ?? { ...o.fallback(), start: Number.MAX_SAFE_INTEGER, end: Number.MAX_SAFE_INTEGER };
    const text = o.getText(target.index, target.field);
    const start = Math.min(target.start, text.length);
    const end = Math.min(target.end, text.length);
    const piece = `{{${token}}}`;
    o.setText(target.index, target.field, text.slice(0, start) + piece + text.slice(end));
    const caret = start + piece.length;
    spot.current = { index: target.index, field: target.field, start: caret, end: caret };
    requestAnimationFrame(() => {
      const el = document.getElementById(o.idFor(target.index, target.field)) as HTMLInputElement | HTMLTextAreaElement | null;
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  }, []);

  return { track, insert };
}

export function MergeFieldPicker({ fields, disabled, onPick }: { fields: MergeFieldItem[]; disabled?: boolean; onPick: (token: string) => void }) {
  if (fields.length === 0) return null;
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <label htmlFor="merge-field-picker" className="shrink-0 whitespace-nowrap text-muted-foreground">
        Insert field
      </label>
      <select
        id="merge-field-picker"
        className="h-8 min-w-0 max-w-full flex-1 rounded-md border bg-background px-2 text-sm sm:max-w-xs"
        disabled={disabled}
        value=""
        onChange={(event) => {
          if (event.target.value) onPick(event.target.value);
        }}
      >
        <option value="">Choose a field</option>
        {GROUPS.map(([group, label]) => {
          const items = fields.filter((f) => f.group === group);
          return items.length === 0 ? null : (
            <optgroup key={group} label={label}>
              {items.map((f) => (
                <option key={f.token} value={f.token}>
                  {f.label === f.token ? f.token : `${f.label} {{${f.token}}}`}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
    </div>
  );
}

/** Lists the tokens a lead cannot fill, so a typo does not reach someone's inbox as a blank. */
export function UnresolvedList({ unresolved }: { unresolved: UnresolvedToken[] | undefined }) {
  if (!unresolved || unresolved.length === 0) return null;
  const unknown = unresolved.filter((u) => u.reason === "unknown");
  const empty = unresolved.filter((u) => u.reason === "empty");
  return (
    // An unfilled token is a warning, not an error: the warning color marks the labels, with no fill and no box.
    <div className="stack-field break-words" role="status">
      {unknown.length > 0 && (
        <p>
          <span className="font-medium text-warning">No such field: </span>
          {unknown.map((u) => `{{${u.token}}}`).join(", ")}. Check the spelling or pick one from Insert field.
        </p>
      )}
      {empty.length > 0 && (
        <p>
          <span className="font-medium text-warning">Empty for this lead: </span>
          {empty.map((u) => `{{${u.token}}}`).join(", ")}
        </p>
      )}
    </div>
  );
}
