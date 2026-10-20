"use client";

import { UploadIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { gridRequest, gridUrl } from "../_lib/data/client";
import { EDITABLE_TYPE_OPTIONS } from "../_lib/view/format";
import { Choice, ErrorText } from "./form-bits";

type Mapping = { headerIndex: number; action: "map"; columnKey: string } | { headerIndex: number; action: "create"; name: string; type: string } | { headerIndex: number; action: "skip" };

interface Preview {
  fileName: string;
  headers: string[];
  rows: string[][];
  totalRows: number;
  maxRows: number;
  mapping: Mapping[];
  columns: Array<{ key: string; name: string; type: string }>;
  /** Workbook sheet names, or null for CSV and single-sheet files. */
  sheets: string[] | null;
  /** The 1-based sheet shown. */
  sheet: number;
  /** Why the chosen sheet cannot be imported. The picker stays so another sheet can be chosen. */
  problem: string | null;
}

interface Props {
  tableId: string;
  onClose: () => void;
  onImported: () => Promise<void>;
  /** A file chosen before the wizard opened (a new workbook made from a file). Its preview and mapping show at once. */
  initialFile?: File;
}

const MAX_BYTES = 5 * 1024 * 1024;

/** CSV or XLSX import in two steps: upload for a preview and a suggested mapping, then confirm the mapping. A workbook with several sheets gets a sheet picker. */
export function ImportWizard({ tableId, onClose, onImported, initialFile }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Mapping[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  /** Reads the preview of `next`, sheet `chosen` (1 when the file is new). Every sheet change re-runs the mapping suggestion. */
  async function load(next: File, chosen: number) {
    setError(null);
    setBusy(true);
    const form = new FormData();
    form.set("file", next);
    if (chosen > 1) form.set("sheet", String(chosen));
    const res = await gridRequest<Preview>(gridUrl.sub(tableId, "import"), "POST", form);
    setBusy(false);
    if (!res.ok || !res.data) return setError(res.error);
    setPreview(res.data);
    setMapping(res.data.mapping);
  }

  async function pick(next: File | null) {
    setError(null);
    setPreview(null);
    setFile(next);
    if (!next) return;
    if (next.size > MAX_BYTES) return setError("The file is larger than 5 MB.");
    await load(next, 1);
  }

  useEffect(() => {
    if (!initialFile) return;
    const handle = setTimeout(() => void pick(initialFile), 0);
    return () => clearTimeout(handle);
    // Runs once, for the file the wizard opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run() {
    if (!file) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set("file", file);
    if (preview && preview.sheet > 1) form.set("sheet", String(preview.sheet));
    form.set("mapping", JSON.stringify(mapping));
    const res = await gridRequest<{ rowsInserted: number; columnsCreated: number }>(gridUrl.sub(tableId, "import"), "POST", form);
    if (!res.ok || !res.data) {
      setBusy(false);
      return setError(res.error);
    }
    const { rowsInserted, columnsCreated } = res.data;
    toast.success(`Imported ${rowsInserted.toLocaleString("en-US")} ${rowsInserted === 1 ? "row" : "rows"}${columnsCreated > 0 ? ` and ${columnsCreated.toLocaleString("en-US")} new ${columnsCreated === 1 ? "column" : "columns"}` : ""}.`);
    await onImported();
    onClose();
  }

  const targets = mapping.filter((m): m is Extract<Mapping, { action: "map" }> => m.action === "map").map((m) => m.columnKey);
  const duplicate = targets.length !== new Set(targets).size;
  const active = mapping.filter((m) => m.action !== "skip").length;
  const set = (index: number, next: Mapping) => setMapping((cur) => cur.map((m) => (m.headerIndex === index ? next : m)));

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import a file</DialogTitle>
          <DialogDescription>CSV or XLSX, up to 5 MB and 10,000 rows. {initialFile ? "The rows go into a new workbook named after the file." : "Rows are added to this table."}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <input ref={input} type="file" accept=".csv,.xlsx,text/csv" className="sr-only" aria-label="File to import" onChange={(e) => void pick(e.target.files?.[0] ?? null)} />
            <Button type="button" variant="outline" onClick={() => input.current?.click()} disabled={busy}>
              <UploadIcon /> {file ? "Choose another file" : "Choose file"}
            </Button>
            {file && <span className="text-sm text-muted-foreground">{file.name}</span>}
          </div>
          <ErrorText>{error}</ErrorText>
          {busy && !preview && <p className="text-sm text-muted-foreground">Reading the file...</p>}

          {preview?.sheets && (
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="import-sheet" className="text-sm font-medium">
                Sheet
              </label>
              <Choice
                id="import-sheet"
                label="Sheet to import"
                className="w-64"
                value={String(preview.sheet)}
                items={preview.sheets.map((name, i) => ({ value: String(i + 1), label: name }))}
                onChange={(v) => file && Number(v) !== preview.sheet && void load(file, Number(v))}
              />
              <span className="text-xs text-muted-foreground">{preview.sheets.length.toLocaleString("en-US")} sheets in this file</span>
            </div>
          )}
          {preview?.problem && (
            <p className="text-sm text-destructive" role="alert">
              {preview.problem} Choose another sheet.
            </p>
          )}

          {preview && !preview.problem && (
            <>
              <p className="text-sm">
                {preview.totalRows.toLocaleString("en-US")} {preview.totalRows === 1 ? "row" : "rows"}, {preview.headers.length.toLocaleString("en-US")} {preview.headers.length === 1 ? "column" : "columns"}. Match each file column to a table column, create a new one, or skip it.
              </p>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs">
                    <tr>
                      <th className="p-2 font-medium">File column</th>
                      <th className="p-2 font-medium">Sample</th>
                      <th className="p-2 font-medium">Action</th>
                      <th className="p-2 font-medium">Target</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.headers.map((header, i) => {
                      const m = mapping.find((x) => x.headerIndex === i) ?? { headerIndex: i, action: "skip" as const };
                      return (
                        <tr key={i} className="border-t align-top">
                          <td className="p-2 font-medium">{header || <span className="text-muted-foreground">(blank)</span>}</td>
                          <td className="max-w-48 p-2 text-xs text-muted-foreground">
                            {preview.rows.slice(0, 3).map((r, k) => (
                              <div key={k} className="truncate">
                                {r[i] || " "}
                              </div>
                            ))}
                          </td>
                          <td className="p-2">
                            <Choice
                              label={`Action for ${header}`}
                              className="w-36"
                              value={m.action}
                              items={[
                                { value: "map", label: "Map to column" },
                                { value: "create", label: "Create column" },
                                { value: "skip", label: "Skip" },
                              ]}
                              onChange={(a) => {
                                if (a === "skip") set(i, { headerIndex: i, action: "skip" });
                                else if (a === "create") set(i, { headerIndex: i, action: "create", name: header.trim() || `Column ${i + 1}`, type: "text" });
                                else set(i, { headerIndex: i, action: "map", columnKey: preview.columns[0]?.key ?? "" });
                              }}
                            />
                          </td>
                          <td className="p-2">
                            {m.action === "map" && (
                              <Choice label={`Target column for ${header}`} className="w-48" value={m.columnKey} items={preview.columns.map((c) => ({ value: c.key, label: c.name }))} onChange={(k) => set(i, { ...m, columnKey: k })} />
                            )}
                            {m.action === "create" && (
                              <div className="flex gap-2">
                                <Input aria-label={`Name of the new column for ${header}`} className="w-40" value={m.name} onChange={(e) => set(i, { ...m, name: e.target.value })} maxLength={120} />
                                <Choice label={`Type for ${header}`} className="w-36" value={m.type} items={EDITABLE_TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} onChange={(t) => set(i, { ...m, type: t })} />
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {duplicate && <p role="alert" className="text-sm text-destructive">Two file columns map to the same table column. Change one.</p>}
              {preview.totalRows > preview.maxRows && <p role="alert" className="text-sm text-destructive">The file has more than {preview.maxRows.toLocaleString("en-US")} rows. Split it and import in parts.</p>}
            </>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={run} disabled={!preview || !!preview.problem || busy || duplicate || active === 0 || preview.totalRows > preview.maxRows}>
            {busy && preview ? "Importing..." : `Import ${preview ? preview.totalRows.toLocaleString("en-US") : ""} ${preview?.totalRows === 1 ? "row" : "rows"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
