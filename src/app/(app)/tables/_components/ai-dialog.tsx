"use client";

import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { gridRequest, gridUrl } from "../_lib/data/client";
import type { GridColumn } from "../_lib/data/types";
import { RunTiming } from "./enrichment-dialog";
import { Choice, ErrorText, Field } from "./form-bits";

interface Props {
  tableId: string;
  columns: GridColumn[];
  /** Set to edit the prompt and timing of an existing AI column. */
  column: GridColumn | null;
  afterColumnId?: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

type OutputType = "text" | "number" | "boolean" | "email" | "url" | "date" | "json";

interface Output {
  key: string;
  type: OutputType;
  description: string;
}

const TYPES = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Yes or no" },
  { value: "email", label: "Email" },
  { value: "url", label: "URL" },
  { value: "date", label: "Date (YYYY-MM-DD)" },
  { value: "json", label: "JSON" },
];

/** The output fields saved in an AI column's config, for the edit form. */
function savedOutputs(column: GridColumn | null): Output[] | null {
  const raw = column?.config.outputs;
  if (!Array.isArray(raw)) return null;
  const known = new Set(TYPES.map((t) => t.value));
  return raw.flatMap((o) => {
    const f = o as { key?: unknown; type?: unknown; description?: unknown };
    return typeof f.key === "string" && typeof f.type === "string" && known.has(f.type) ? [{ key: f.key, type: f.type as OutputType, description: typeof f.description === "string" ? f.description : "" }] : [];
  });
}

const toKey = (label: string) => {
  const words = label.replace(/[^A-Za-z0-9 ]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const key = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join("");
  return /^[a-z]/.test(key) ? key.slice(0, 40) : `f${key}`.slice(0, 40);
};

/** Creates or edits an AI column. The prompt reads other columns with {{key}} and each output field becomes a column. */
export function AiDialog({ tableId, columns, column, afterColumnId, onClose, onSaved }: Props) {
  const [name, setName] = useState(column?.name ?? "");
  const [prompt, setPrompt] = useState(typeof column?.config.prompt === "string" ? column.config.prompt : "");
  const [outputs, setOutputs] = useState<Output[]>(() => savedOutputs(column) ?? [{ key: "answer", type: "text", description: "" }]);
  const [autoRun, setAutoRun] = useState(column?.autoRun ?? false);
  const [delay, setDelay] = useState(String(column?.config.delaySeconds ?? 0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sources = columns.filter((c) => c.id !== column?.id);
  const keysOk = outputs.every((o) => /^[a-z][A-Za-z0-9_]{0,39}$/.test(o.key)) && new Set(outputs.map((o) => o.key)).size === outputs.length;
  const ready = prompt.trim().length > 0 && outputs.length > 0 && keysOk;

  async function save() {
    setBusy(true);
    setError(null);
    const delaySeconds = Math.max(0, Math.min(3600, Math.floor(Number(delay) || 0)));
    const res = column
      ? await gridRequest(gridUrl.sub(tableId, "ai"), "PATCH", {
          columnId: column.id,
          prompt,
          autoRun,
          delaySeconds,
          outputs: outputs.map((o) => ({ key: o.key, type: o.type, ...(o.description.trim() ? { description: o.description.trim() } : {}) })),
        })
      : await gridRequest(gridUrl.sub(tableId, "ai"), "POST", {
          name: name.trim() || undefined,
          prompt,
          outputs: outputs.map((o) => ({ key: o.key, type: o.type, ...(o.description.trim() ? { description: o.description.trim() } : {}) })),
          afterColumnId: afterColumnId ?? columns[columns.length - 1]?.id,
          autoRun,
          delaySeconds,
        });
    if (!res.ok) {
      setBusy(false);
      return setError(res.error);
    }
    await onSaved();
    onClose();
  }

  function insert(token: string) {
    setPrompt((p) => (p && !p.endsWith(" ") && !p.endsWith("\n") ? `${p} ${token}` : p + token));
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{column ? `Edit ${column.name}` : "Add AI column"}</DialogTitle>
          <DialogDescription>Each cell is answered by the AI key your organization saved in Settings, Integrations. Cell values are sent as untrusted data, not as instructions.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {!column && (
            <Field label="Column name" htmlFor="ai-name">
              <Input id="ai-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="AI" maxLength={120} />
            </Field>
          )}
          <Field label="Prompt" htmlFor="ai-prompt">
            <Textarea id="ai-prompt" rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={8000} placeholder="Write a one-line summary of what {{company}} does." />
          </Field>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Insert:</span>
            {sources.map((c) => (
              <Button key={c.id} type="button" size="xs" variant="outline" onClick={() => insert(`{{${c.key}}}`)}>
                {c.name}
              </Button>
            ))}
          </div>
          {(!column || savedOutputs(column) !== null) && (
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">Output fields</legend>
              {outputs.map((o, i) => (
                <div key={i} className="grid gap-2 rounded-lg border p-2 sm:grid-cols-[8rem_9rem_1fr_auto]">
                  <Input aria-label="Field key" value={o.key} onChange={(e) => setOutputs((s) => s.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} onBlur={() => setOutputs((s) => s.map((x, j) => (j === i ? { ...x, key: toKey(x.key) } : x)))} />
                  <Choice label="Field type" items={TYPES} value={o.type} onChange={(v) => setOutputs((s) => s.map((x, j) => (j === i ? { ...x, type: v as Output["type"] } : x)))} />
                  <Input aria-label="Field description" placeholder="What this field holds (optional)" maxLength={300} value={o.description} onChange={(e) => setOutputs((s) => s.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
                  <Button type="button" size="icon" variant="ghost" aria-label="Remove field" disabled={outputs.length === 1} onClick={() => setOutputs((s) => s.filter((_, j) => j !== i))}>
                    <Trash2Icon />
                  </Button>
                </div>
              ))}
              {column && <p className="text-xs text-muted-foreground">A field keeps its column when its key or its column name stays. A column that has values cannot change type. A field you remove stops filling its column; delete the column from its menu.</p>}
              {!keysOk && <p className="text-xs text-destructive">Field keys start with a lowercase letter, use letters and digits, and cannot repeat.</p>}
              {outputs.length < 12 && (
                <div>
                  <Button type="button" size="sm" variant="outline" onClick={() => setOutputs((s) => [...s, { key: `field${s.length + 1}`, type: "text", description: "" }])}>
                    <PlusIcon /> Add field
                  </Button>
                </div>
              )}
            </fieldset>
          )}
          <RunTiming autoRun={autoRun} setAutoRun={setAutoRun} delay={delay} setDelay={setDelay} />
          <ErrorText>{error}</ErrorText>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={!ready || busy}>
            {busy ? "Saving..." : column ? "Save" : "Add columns"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
