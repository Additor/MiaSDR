"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FILTER_OPERATORS, type FilterOperator, type TableView } from "@/contexts/grid/domain/view-query";
import { gridRequest, gridUrl } from "../_lib/data/client";
import { EDITABLE_TYPE_OPTIONS, selectOptions, typeLabel } from "../_lib/view/format";
import type { GridColumn } from "../_lib/data/types";
import { addFilter, OPERATOR_LABELS, operatorNeedsValue } from "../_lib/view/view";
import type { ColumnAction } from "./column-menu";
import { Choice, ErrorText, Field } from "./form-bits";

export type ColumnRequest = { column: GridColumn; action: ColumnAction } | { column: null; action: { kind: "add"; afterColumnId?: string; beforeColumnId?: string } };

interface Props {
  tableId: string;
  columns: GridColumn[];
  view: TableView;
  request: ColumnRequest | null;
  onClose: () => void;
  /** Reload the table after a structural change. */
  onChanged: () => Promise<void>;
  saveView: (view: TableView) => Promise<boolean>;
}

/** The small dialogs behind the column menu. Each one sends one request and reloads the table. */
export function ColumnDialogs({ tableId, columns, view, request, onClose, onChanged, saveView }: Props) {
  if (!request) return null;
  const common = { tableId, onClose, onChanged };
  const { action } = request;
  if (request.column === null) return <AddColumnDialog {...common} columns={columns} where={request.action} />;
  const column = request.column;
  switch (action.kind) {
    case "rename":
      return <RenameDialog {...common} column={column} />;
    case "type":
      return <TypeDialog {...common} column={column} type={(action as { type: string }).type} />;
    case "config":
      return <OptionsDialog {...common} column={column} />;
    case "delete":
      return <DeleteDialog {...common} column={column} />;
    case "dedupe":
      return <DedupeDialog {...common} column={column} />;
    case "textToColumns":
      return <SplitDialog {...common} column={column} />;
    case "filter":
      return <FilterDialog column={column} view={view} saveView={saveView} onClose={onClose} />;
    case "insert":
      return <AddColumnDialog {...common} columns={columns} where={(action as { side: string }).side === "left" ? { beforeColumnId: column.id } : { afterColumnId: column.id }} />;
    default:
      return null;
  }
}

interface Shared {
  tableId: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}

function useRequest(onClose: () => void, onChanged: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(call: () => Promise<{ ok: boolean; error: string | null; data: T | null }>, done?: (data: T) => void) {
    setBusy(true);
    setError(null);
    const res = await call();
    if (!res.ok) {
      setError(res.error);
      setBusy(false);
      return;
    }
    await onChanged();
    if (res.data !== null && done) done(res.data);
    setBusy(false);
    onClose();
  }
  return { busy, error, run };
}

function Shell({ title, description, onClose, children, footer }: { title: string; description?: string; onClose: () => void; children?: React.ReactNode; footer: React.ReactNode }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Footer({ onClose, busy, label, onSubmit, destructive, disabled }: { onClose: () => void; busy: boolean; label: string; onSubmit: () => void; destructive?: boolean; disabled?: boolean }) {
  return (
    <>
      <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
        Cancel
      </Button>
      <Button type="button" variant={destructive ? "destructive" : "default"} onClick={onSubmit} disabled={busy || disabled}>
        {busy ? "Working..." : label}
      </Button>
    </>
  );
}

function RenameDialog({ tableId, column, onClose, onChanged }: Shared & { column: GridColumn }) {
  const [name, setName] = useState(column.name);
  const { busy, error, run } = useRequest(onClose, onChanged);
  const submit = () => run(() => gridRequest(`${gridUrl.sub(tableId, "columns")}/${column.id}`, "PATCH", { name }));
  return (
    <Shell title="Rename column" onClose={onClose} footer={<Footer onClose={onClose} busy={busy} label="Rename" onSubmit={submit} disabled={!name.trim()} />}>
      <form onSubmit={(e) => (e.preventDefault(), submit())} className="grid gap-3">
        <Field label="Name" htmlFor="col-name">
          <Input id="col-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={120} />
        </Field>
        <ErrorText>{error}</ErrorText>
      </form>
    </Shell>
  );
}

function TypeDialog({ tableId, column, type, onClose, onChanged }: Shared & { column: GridColumn; type: string }) {
  const { busy, error, run } = useRequest(onClose, onChanged);
  const submit = () => run(() => gridRequest(`${gridUrl.sub(tableId, "columns")}/${column.id}`, "PATCH", { type }));
  return (
    <Shell
      title={`Change type to ${typeLabel(type)}`}
      description={`Values in "${column.name}" convert where they fit. A value that does not fit stays as it was typed.`}
      onClose={onClose}
      footer={<Footer onClose={onClose} busy={busy} label="Change type" onSubmit={submit} />}
    >
      <ErrorText>{error}</ErrorText>
    </Shell>
  );
}

function OptionsDialog({ tableId, column, onClose, onChanged }: Shared & { column: GridColumn }) {
  const isSelect = column.type === "select" || column.type === "multiselect";
  const [options, setOptions] = useState(selectOptions(column).map((o) => o.value).join("\n"));
  const [currency, setCurrency] = useState(typeof column.config.currency === "string" ? column.config.currency : "USD");
  const { busy, error, run } = useRequest(onClose, onChanged);
  const submit = () => {
    const config = isSelect
      ? { ...column.config, options: [...new Set(options.split("\n").map((o) => o.trim()).filter(Boolean))] }
      : { ...column.config, currency: currency.trim().toUpperCase() };
    return run(() => gridRequest(`${gridUrl.sub(tableId, "columns")}/${column.id}`, "PATCH", { config }));
  };
  return (
    <Shell title={isSelect ? "Edit options" : "Edit currency"} onClose={onClose} footer={<Footer onClose={onClose} busy={busy} label="Save" onSubmit={submit} />}>
      {isSelect ? (
        <Field label="Options" htmlFor="col-options" hint="One option per line.">
          <Textarea id="col-options" rows={8} value={options} onChange={(e) => setOptions(e.target.value)} />
        </Field>
      ) : (
        <Field label="Currency code" htmlFor="col-currency" hint="Three letters, such as USD or EUR.">
          <Input id="col-currency" value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={8} className="w-32" />
        </Field>
      )}
      <ErrorText>{error}</ErrorText>
    </Shell>
  );
}

function DeleteDialog({ tableId, column, onClose, onChanged }: Shared & { column: GridColumn }) {
  const hasOutputs = ["enrichment", "waterfall", "ai"].includes(column.type);
  const [withOutputs, setWithOutputs] = useState(false);
  const { busy, error, run } = useRequest(onClose, onChanged);
  const submit = () => run(() => gridRequest(`${gridUrl.sub(tableId, "columns")}/${column.id}${withOutputs ? "?withOutputs=1" : ""}`, "DELETE"));
  return (
    <Shell
      title={`Delete "${column.name}"?`}
      description="The column and its values are removed from every row. Queued runs for it are dropped. This cannot be undone."
      onClose={onClose}
      footer={<Footer onClose={onClose} busy={busy} label="Delete column" onSubmit={submit} destructive />}
    >
      {hasOutputs && (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={withOutputs} onCheckedChange={(v) => setWithOutputs(v === true)} />
          Also delete the output columns it fills
        </label>
      )}
      <ErrorText>{error}</ErrorText>
    </Shell>
  );
}

function DedupeDialog({ tableId, column, onClose, onChanged }: Shared & { column: GridColumn }) {
  const { busy, error, run } = useRequest(onClose, onChanged);
  const submit = () =>
    run(
      () => gridRequest<{ deleted?: number }>(`${gridUrl.sub(tableId, "columns")}/${column.id}/dedupe`, "POST"),
      (data) => {
        const n = data.deleted ?? 0;
        toast.success(n === 0 ? "No duplicates found." : `Removed ${n} duplicate row${n === 1 ? "" : "s"}.`);
      },
    );
  return (
    <Shell
      title={`Remove duplicates in "${column.name}"?`}
      description="Rows that repeat an earlier row's value in this column are deleted. The first row stays and blank values are kept. This cannot be undone."
      onClose={onClose}
      footer={<Footer onClose={onClose} busy={busy} label="Remove duplicates" onSubmit={submit} destructive />}
    >
      <ErrorText>{error}</ErrorText>
    </Shell>
  );
}

const DELIMITERS = [
  { value: "comma", label: "Comma" },
  { value: "space", label: "Space" },
  { value: "semicolon", label: "Semicolon" },
  { value: "pipe", label: "Pipe" },
];

function SplitDialog({ tableId, column, onClose, onChanged }: Shared & { column: GridColumn }) {
  const [delimiter, setDelimiter] = useState("comma");
  const { busy, error, run } = useRequest(onClose, onChanged);
  const submit = () =>
    run(
      () => gridRequest<{ columnsCreated?: number; rowsUpdated?: number }>(`${gridUrl.sub(tableId, "columns")}/${column.id}/text-to-columns`, "POST", { delimiter }),
      (data) => toast.success(`Created ${data.columnsCreated ?? 0} columns from ${data.rowsUpdated ?? 0} rows.`),
    );
  return (
    <Shell
      title={`Text to columns: "${column.name}"`}
      description="Splits each value at the separator and puts the parts into new columns to the right."
      onClose={onClose}
      footer={<Footer onClose={onClose} busy={busy} label="Split" onSubmit={submit} />}
    >
      <Field label="Separator" htmlFor="split-delim">
        <Choice id="split-delim" items={DELIMITERS} value={delimiter} onChange={setDelimiter} className="w-48" />
      </Field>
      <ErrorText>{error}</ErrorText>
    </Shell>
  );
}

function FilterDialog({ column, view, saveView, onClose }: { column: GridColumn; view: TableView; saveView: (v: TableView) => Promise<boolean>; onClose: () => void }) {
  const [operator, setOperator] = useState<FilterOperator>("contains");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const items = FILTER_OPERATORS.map((o) => ({ value: o, label: OPERATOR_LABELS[o] }));
  const submit = async () => {
    setBusy(true);
    const ok = await saveView(addFilter(view, { columnKey: column.key, operator, ...(operatorNeedsValue(operator) ? { value } : {}) }));
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Shell title={`Filter "${column.name}"`} description="The filter is saved for you and only changes what you see. Owners and admins can save the current view as the default for everyone." onClose={onClose} footer={<Footer onClose={onClose} busy={busy} label="Add filter" onSubmit={submit} />}>
      <form onSubmit={(e) => (e.preventDefault(), void submit())} className="grid gap-3">
        <Field label="Condition" htmlFor="filter-op">
          <Choice id="filter-op" items={items} value={operator} onChange={(v) => setOperator(v as FilterOperator)} />
        </Field>
        {operatorNeedsValue(operator) && (
          <Field label="Value" htmlFor="filter-value">
            <Input id="filter-value" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
          </Field>
        )}
        {/* The select adds a second field, so Enter needs a submit button to trigger the form. */}
        <button type="submit" hidden />
      </form>
    </Shell>
  );
}

function AddColumnDialog({ tableId, columns, where, onClose, onChanged }: Shared & { columns: GridColumn[]; where: { afterColumnId?: string; beforeColumnId?: string } }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("text");
  const { busy, error, run } = useRequest(onClose, onChanged);
  const last = columns[columns.length - 1];
  const submit = () =>
    run(() =>
      gridRequest(gridUrl.sub(tableId, "columns"), "POST", {
        name: name.trim() || typeLabel(type),
        type,
        afterColumnId: where.afterColumnId ?? (where.beforeColumnId ? undefined : last?.id),
        beforeColumnId: where.beforeColumnId,
      }),
    );
  return (
    <Shell title="Add column" onClose={onClose} footer={<Footer onClose={onClose} busy={busy} label="Add column" onSubmit={submit} />}>
      <form onSubmit={(e) => (e.preventDefault(), submit())} className="grid gap-3">
        <Field label="Name" htmlFor="new-col-name">
          <Input id="new-col-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={120} placeholder="Column name" />
        </Field>
        <Field label="Type" htmlFor="new-col-type">
          <Choice id="new-col-type" items={EDITABLE_TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} value={type} onChange={setType} className="w-56" />
        </Field>
        <button type="submit" hidden />
        <ErrorText>{error}</ErrorText>
      </form>
    </Shell>
  );
}
