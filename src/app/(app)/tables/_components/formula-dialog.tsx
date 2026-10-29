"use client";

import { SparklesIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { gridUrl } from "../_lib/data/client";
import { useCellRequest } from "../_lib/data/cell-request";
import type { GridColumn } from "../_lib/data/types";

interface Props {
  tableId: string;
  columns: GridColumn[];
  /** Set to edit an existing formula column. */
  column: GridColumn | null;
  afterColumnId?: string;
  /** Row to preview against. The first row when omitted. */
  previewRowId?: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

type Preview = { state: "idle" } | { state: "loading" } | { state: "ok"; text: string; rowNumber: number } | { state: "error"; message: string };

const FUNCTION_HINT = "IF, COALESCE, CONCATENATE, UPPER, LOWER, TRIM, LEN, LEFT, RIGHT, MID, SUBSTITUTE, CONTAINS, SPLIT, DOMAIN, ROUND, SUM, AVERAGE, LOOKUP and more";

function show(value: unknown): string {
  if (value === null || value === undefined) return "(empty)";
  if (typeof value === "string") return value === "" ? '(empty text)' : value;
  return JSON.stringify(value);
}

/** Creates or edits a formula column, with a live preview on one row and an AI helper that writes the expression. */
export function FormulaDialog({ tableId, columns, column, afterColumnId, previewRowId, onClose, onSaved }: Props) {
  const cellRequest = useCellRequest();
  const [name, setName] = useState(column?.name ?? "");
  const [expression, setExpression] = useState(typeof column?.config.expression === "string" ? column.config.expression : "");
  const [autoRun, setAutoRun] = useState(column?.autoRun ?? true);
  const [preview, setPreview] = useState<Preview>({ state: "idle" });
  const [prompt, setPrompt] = useState("");
  const [explanation, setExplanation] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const token = useRef(0);

  useEffect(() => {
    const mine = ++token.current;
    if (!expression.trim()) return;
    const handle = setTimeout(async () => {
      setPreview({ state: "loading" });
      const res = await cellRequest<{ value: unknown; rowNumber: number }>(gridUrl.sub(tableId, "formula-preview"), "POST", { expression, rowId: previewRowId });
      if (mine !== token.current) return;
      setPreview(res.ok && res.data ? { state: "ok", text: show(res.data.value), rowNumber: res.data.rowNumber } : { state: "error", message: res.error ?? "The formula could not be evaluated." });
    }, 450);
    return () => clearTimeout(handle);
  }, [expression, tableId, previewRowId, cellRequest]);

  function insert(text: string) {
    const el = area.current;
    if (!el) return setExpression((e) => e + text);
    const start = el.selectionStart ?? expression.length;
    const end = el.selectionEnd ?? start;
    setExpression(expression.slice(0, start) + text + expression.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + text.length, start + text.length);
    });
  }

  async function generate() {
    setAiBusy(true);
    setAiError(null);
    const res = await cellRequest<{ formula: string; explanation: string }>(gridUrl.sub(tableId, "formula-generate"), "POST", { prompt, currentExpression: expression.trim() || undefined });
    setAiBusy(false);
    if (!res.ok || !res.data) return setAiError(res.error);
    setExpression(res.data.formula);
    setExplanation(res.data.explanation);
  }

  async function save() {
    setSaving(true);
    setError(null);
    const res = column
      ? await cellRequest(`${gridUrl.sub(tableId, "columns")}/${column.id}`, "PATCH", { ...(name.trim() && name.trim() !== column.name ? { name: name.trim() } : {}), config: { ...column.config, expression }, autoRun })
      : await cellRequest(gridUrl.sub(tableId, "columns"), "POST", { name: name.trim() || "Formula", type: "formula", config: { expression }, autoRun, afterColumnId: afterColumnId ?? columns[columns.length - 1]?.id });
    if (!res.ok) {
      setError(res.error);
      setSaving(false);
      return;
    }
    await onSaved();
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{column ? `Edit formula: ${column.name}` : "Add formula column"}</DialogTitle>
          <DialogDescription>
            Write one expression. Use {"{{columnKey}}"} to read a cell. Available: {FUNCTION_HINT}.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="f-name">Column name</FieldLabel>
            <Input id="f-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Formula" maxLength={120} />
          </Field>
          <Field>
            <FieldLabel htmlFor="f-expr">Expression</FieldLabel>
            <Textarea ref={area} id="f-expr" rows={4} className="font-mono text-sm" spellCheck={false} value={expression} onChange={(e) => setExpression(e.target.value)} placeholder={'UPPER({{first_name}}) & " " & {{last_name}}'} />
          </Field>
          <div className="flex flex-wrap items-center gap-1.5" aria-label="Insert a column">
            <span className="text-xs text-muted-foreground">Insert:</span>
            {columns.filter((c) => c.id !== column?.id).map((c) => (
              <Button key={c.id} type="button" size="xs" variant="outline" onClick={() => insert(`{{${c.key}}}`)}>
                {c.name}
              </Button>
            ))}
          </div>

          {/* The preview reads as body text under the expression, with no box around it. */}
          <div aria-live="polite" className="stack-field text-sm">
            <p className="text-xs font-medium text-muted-foreground">Preview{preview.state === "ok" ? ` (row ${preview.rowNumber})` : ""}</p>
            {(preview.state === "idle" || !expression.trim()) && <p className="text-muted-foreground">Type an expression to see its result.</p>}
            {expression.trim() && preview.state === "loading" && <p className="text-muted-foreground">Evaluating…</p>}
            {expression.trim() && preview.state === "ok" && <p className="font-mono break-all">{preview.text}</p>}
            {expression.trim() && preview.state === "error" && <p className="text-destructive">{preview.message}</p>}
          </div>

          <Field>
            <FieldLabel htmlFor="f-ai">Describe it and let AI write the formula</FieldLabel>
            <div className="flex gap-2">
              <Input id="f-ai" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Full name from first and last name, in title case" maxLength={2000} onKeyDown={(e) => e.key === "Enter" && prompt.trim() && !aiBusy && (e.preventDefault(), void generate())} />
              <Button type="button" variant="outline" disabled={!prompt.trim() || aiBusy} onClick={generate}>
                <SparklesIcon /> {aiBusy ? "Writing…" : "Generate"}
              </Button>
            </div>
            {explanation && <FieldDescription>{explanation}</FieldDescription>}
            <FieldError>{aiError}</FieldError>
          </Field>

          <Field orientation="horizontal">
            <Checkbox id="f-auto-run" checked={autoRun} onCheckedChange={(v) => setAutoRun(v === true)} />
            <FieldLabel htmlFor="f-auto-run">Recalculate when the cells it reads change</FieldLabel>
          </Field>
          <FieldError>{error}</FieldError>
        </FieldGroup>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={saving || !expression.trim() || (preview.state === "error" && !!expression.trim())}>
            {saving ? "Saving…" : column ? "Save formula" : "Add column"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
