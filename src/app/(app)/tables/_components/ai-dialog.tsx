"use client";

import { FlaskConicalIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { AiStatus } from "@/contexts/integrations/domain/ai-status";
import { gridRequest, gridUrl } from "../_lib/data/client";
import { columnForInput } from "../_lib/data/providers";
import { delaySecondsOf } from "../_lib/data/run-request";
import type { GridColumn } from "../_lib/data/types";
import { CreateFooter, createColumn, RunTiming } from "./enrichment-dialog";
import { ItemSelect } from "./form-bits";

interface Props {
  tableId: string;
  columns: GridColumn[];
  /** Set to edit the prompt and timing of an existing AI column. */
  column: GridColumn | null;
  afterColumnId?: string;
  /** The first row of the current view, the one "Test on row 1" asks about. */
  firstRowId?: string;
  onClose: () => void;
  /** After a save; `addedKey` is the new column's key, so the grid can bring it into view. */
  onSaved: (addedKey?: string) => Promise<void>;
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

type Known = Parameters<typeof columnForInput>[0];

interface Template {
  label: string;
  outputs: Output[];
  prompt: (t: (input: Known, fallback: string) => string) => string;
}

/** Starting prompts for the work an SDR asks of a row. Each reads the table's own columns where it has them. */
const TEMPLATES: Template[] = [
  {
    label: "Opening line",
    outputs: [{ key: "opener", type: "text", description: "One sentence, under 25 words" }],
    prompt: (t) =>
      `Write one opening line for a cold email to ${t("fullName", "this person")}, ${t("title", "their role")} at ${t("companyName", "their company")}. Name something specific to their role or company. No greeting and no sign-off.`,
  },
  {
    label: "Fit score",
    outputs: [
      { key: "fitScore", type: "number", description: "1 to 10" },
      { key: "reason", type: "text", description: "One sentence" },
    ],
    prompt: (t) => `From 1 to 10, how well does ${t("companyName", "this company")} (${t("companyDomain", "no website given")}) fit a team that sells [what you sell, to whom]? Give the score and one sentence of reason.`,
  },
  {
    label: "Company summary",
    outputs: [{ key: "summary", type: "text", description: "One sentence" }],
    prompt: (t) => `In one sentence, say what ${t("companyName", "the company")} (${t("companyDomain", "no website given")}) does and who it sells to. Say "Unknown" if the data does not tell you.`,
  },
  {
    label: "Clean job title",
    outputs: [
      { key: "title", type: "text", description: "The title in plain words" },
      { key: "seniority", type: "text", description: "IC, manager, director or executive" },
    ],
    prompt: (t) => `Rewrite the job title ${t("title", "(no title given)")} in plain words, and give its seniority: IC, manager, director or executive.`,
  },
];

interface Preview {
  fields: Array<{ key: string; value: unknown; error: string | null }>;
  provider: string;
  model: string;
}

const previewText = (v: unknown) => (v === null || v === undefined || v === "" ? "Empty" : typeof v === "string" ? v : JSON.stringify(v));

/** Creates or edits an AI column. The prompt reads other columns with {{key}} and each output field becomes a column. */
export function AiDialog({ tableId, columns, column, afterColumnId, firstRowId, onClose, onSaved }: Props) {
  const [name, setName] = useState(column?.name ?? "");
  const [prompt, setPrompt] = useState(typeof column?.config.prompt === "string" ? column.config.prompt : "");
  const [outputs, setOutputs] = useState<Output[]>(() => savedOutputs(column) ?? [{ key: "answer", type: "text", description: "" }]);
  const [autoRun, setAutoRun] = useState(column?.autoRun ?? false);
  const [delay, setDelay] = useState(String(column?.config.delaySeconds ?? 0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ai, setAi] = useState<{ status: AiStatus; off: string | null } | null>(null);
  const [preview, setPreview] = useState<{ draft: string; result: Preview | null; error: string | null } | null>(null);
  const [testing, setTesting] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // What the column runs on, so the person knows which model answers before anything spends.
  useEffect(() => {
    let cancelled = false;
    void gridRequest<{ status: AiStatus; off: string | null }>("/api/grid/ai-status", "GET").then((res) => {
      if (!cancelled && res.ok && res.data) setAi(res.data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const sources = columns.filter((c) => c.id !== column?.id);
  const keysOk = outputs.every((o) => /^[a-z][A-Za-z0-9_]{0,39}$/.test(o.key)) && new Set(outputs.map((o) => o.key)).size === outputs.length;
  const ready = prompt.trim().length > 0 && outputs.length > 0 && keysOk;
  const fieldsBody = outputs.map((o) => ({ key: o.key, type: o.type, ...(o.description.trim() ? { description: o.description.trim() } : {}) }));
  // A test answer shows only while the prompt and fields it answered stay as they were.
  const draft = JSON.stringify({ prompt, fieldsBody });
  const shownPreview = preview && preview.draft === draft ? preview : null;
  const aiOff = ai?.off ?? null;

  async function save(run: boolean) {
    setBusy(true);
    setError(null);
    const delaySeconds = delaySecondsOf(delay);
    if (column) {
      const res = await gridRequest(gridUrl.sub(tableId, "ai"), "PATCH", { columnId: column.id, prompt, autoRun, delaySeconds, outputs: fieldsBody });
      if (!res.ok) {
        setBusy(false);
        return setError(res.error);
      }
      await onSaved();
      return onClose();
    }
    const res = await createColumn(tableId, { name: name.trim() || undefined, prompt, outputs: fieldsBody, afterColumnId: afterColumnId ?? columns[columns.length - 1]?.id, autoRun, delaySeconds }, run, "ai");
    if (!res.ok) {
      setBusy(false);
      return setError(res.error);
    }
    await onSaved(res.key);
    onClose();
  }

  async function test() {
    setTesting(true);
    const res = await gridRequest<Preview>(`${gridUrl.sub(tableId, "ai")}/preview`, "POST", { prompt, outputs: fieldsBody, ...(firstRowId ? { rowId: firstRowId } : {}) });
    setTesting(false);
    setPreview({ draft, result: res.ok ? res.data : null, error: res.ok ? null : res.error });
  }

  /** Puts a column token where the cursor is, or at the end when the prompt has no focus yet. */
  function insert(token: string) {
    const el = promptRef.current;
    const start = el?.selectionStart ?? prompt.length;
    const end = el?.selectionEnd ?? prompt.length;
    const before = prompt.slice(0, start);
    const pad = before && !/\s$/.test(before) ? " " : "";
    const next = `${before}${pad}${token}${prompt.slice(end)}`;
    setPrompt(next);
    const caret = start + pad.length + token.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  }

  function applyTemplate(t: Template) {
    const fill = (input: Known, fallback: string) => {
      const key = columnForInput(input, columns);
      return key ? `{{${key}}}` : fallback;
    };
    setPrompt(t.prompt(fill));
    setOutputs(t.outputs);
    if (!name.trim()) setName(t.label);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{column ? `Edit ${column.name}` : "Add AI column"}</DialogTitle>
          <DialogDescription>
            {ai?.status.state === "on"
              ? `Each row is answered by ${ai.status.provider}, ${ai.status.model}, on your organization's AI key. Cell values go in as data, not as instructions.`
              : ai?.status.state === "demo"
                ? "Demo mode: answers come from a stand-in, and no provider is called."
                : "Each row is answered on your organization's AI key. Cell values go in as data, not as instructions."}
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          {aiOff && (
            <p role="status" className="text-sm">
              {aiOff}
            </p>
          )}
          {!column && !prompt.trim() && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Start from</span>
              {TEMPLATES.map((t) => (
                <Button key={t.label} type="button" size="xs" variant="outline" onClick={() => applyTemplate(t)}>
                  {t.label}
                </Button>
              ))}
            </div>
          )}
          {!column && (
            <Field>
              <FieldLabel htmlFor="ai-name">Column name</FieldLabel>
              <Input id="ai-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="AI" maxLength={120} />
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor="ai-prompt">Prompt</FieldLabel>
            <Textarea ref={promptRef} id="ai-prompt" rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={8000} placeholder="Write a one-line summary of what {{company}} does." aria-describedby="ai-prompt-hint" />
            <FieldDescription id="ai-prompt-hint">The column shows the answer to the first field. Click a column below to put it in the prompt where the cursor is.</FieldDescription>
          </Field>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Columns</span>
            {sources.map((c) => (
              <Button key={c.id} type="button" size="xs" variant="outline" onClick={() => insert(`{{${c.key}}}`)}>
                {c.name}
              </Button>
            ))}
          </div>
          {(!column || savedOutputs(column) !== null) && (
            <FieldSet className="gap-2">
              <FieldLegend variant="label">Output fields</FieldLegend>
              {/* One ruled list, no box per field. */}
              <div className="divide-y">
                {outputs.map((o, i) => (
                  <div key={i} className="grid gap-2 py-2 first:pt-0 sm:grid-cols-[8rem_9rem_1fr_auto]">
                    <Input aria-label="Field key" value={o.key} onChange={(e) => setOutputs((s) => s.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} onBlur={() => setOutputs((s) => s.map((x, j) => (j === i ? { ...x, key: toKey(x.key) } : x)))} />
                    <ItemSelect label="Field type" items={TYPES} value={o.type} onChange={(v) => setOutputs((s) => s.map((x, j) => (j === i ? { ...x, type: v as Output["type"] } : x)))} />
                    <Input aria-label="Field description" placeholder="What this field holds (optional)" maxLength={300} value={o.description} onChange={(e) => setOutputs((s) => s.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
                    <Button type="button" size="icon" variant="ghost" aria-label="Remove field" disabled={outputs.length === 1} onClick={() => setOutputs((s) => s.filter((_, j) => j !== i))}>
                      <Trash2Icon />
                    </Button>
                  </div>
                ))}
              </div>
              {column && <p className="text-xs text-muted-foreground">A field keeps its column when its key or its column name stays. A column that has values cannot change type. A field you remove stops filling its column; delete the column from its menu.</p>}
              {!keysOk && <p className="text-xs text-destructive">Field keys start with a lowercase letter, use letters and digits, and cannot repeat.</p>}
              {outputs.length < 12 && (
                <div>
                  <Button type="button" size="sm" variant="outline" onClick={() => setOutputs((s) => [...s, { key: `field${s.length + 1}`, type: "text", description: "" }])}>
                    <PlusIcon /> Add field
                  </Button>
                </div>
              )}
            </FieldSet>
          )}
          <section aria-label="Test answer" className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => void test()} disabled={!ready || testing || !!aiOff}>
                <FlaskConicalIcon /> {testing ? "Asking…" : "Test on row 1"}
              </Button>
              <span className="text-xs text-muted-foreground">One AI call. Nothing is saved.</span>
            </div>
            {shownPreview?.error && <FieldError>{shownPreview.error}</FieldError>}
            {shownPreview?.result && (
              <dl aria-live="polite" className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                {shownPreview.result.fields.map((f) => (
                  <div key={f.key} className="contents">
                    <dt className="text-muted-foreground">{f.key}</dt>
                    <dd className={f.error ? "text-destructive" : "[overflow-wrap:anywhere]"}>{f.error ?? previewText(f.value)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
          <RunTiming autoRun={autoRun} setAutoRun={setAutoRun} delay={delay} setDelay={setDelay} />
          <FieldError>{error}</FieldError>
        </FieldGroup>
        {column ? (
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void save(false)} disabled={!ready || busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        ) : (
          <CreateFooter blocker={!prompt.trim() ? "Write a prompt or start from one above." : !keysOk ? "Fix the field keys." : null} busy={busy} onBack={onClose} onSave={(run) => void save(run)} backLabel="Cancel" />
        )}
      </DialogContent>
    </Dialog>
  );
}
