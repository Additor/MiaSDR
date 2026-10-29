"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { countOf } from "@/shared/format-number";
import { FILTER_OPERATORS, type FilterOperator, type TableView } from "@/contexts/grid/domain/view-query";
import { gridRequest, gridUrl, type GridResponse } from "../_lib/data/client";
import { EDITABLE_TYPE_OPTIONS, selectOptions, typeLabel } from "../_lib/view/format";
import type { GridColumn } from "../_lib/data/types";
import { RUN_FILLED_TYPES } from "../_lib/edit/filter-edit";
import { addFilter, OPERATOR_LABELS, operatorNeedsValue } from "../_lib/view/view";
import type { ColumnAction } from "./column-menu";
import { ItemSelect } from "./form-bits";

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
  /** Removes duplicate rows through the grid hook, which settles queued edits and forgets the removed rows. */
  dedupe: (columnId: string) => Promise<GridResponse<{ deleted: number }>>;
}

/** The small dialogs behind the column menu. Each one sends one request and reloads the table. */
export function ColumnDialogs({ tableId, columns, view, request, onClose, onChanged, saveView, dedupe }: Props) {
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
      return <DedupeDialog column={column} dedupe={dedupe} onClose={onClose} />;
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
        {busy ? "Working…" : label}
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
      <form onSubmit={(e) => (e.preventDefault(), submit())}>
        <Field>
          <FieldLabel htmlFor="col-name">Name</FieldLabel>
          <Input id="col-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={120} />
          <FieldError>{error}</FieldError>
        </Field>
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
      <FieldError>{error}</FieldError>
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
        <Field>
          <FieldLabel htmlFor="col-options">Options</FieldLabel>
          <Textarea id="col-options" rows={8} value={options} onChange={(e) => setOptions(e.target.value)} aria-describedby="col-options-hint" />
          <FieldDescription id="col-options-hint">One option per line.</FieldDescription>
        </Field>
      ) : (
        <Field>
          <FieldLabel htmlFor="col-currency">Currency code</FieldLabel>
          <Input id="col-currency" value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={8} className="w-32" aria-describedby="col-currency-hint" />
          <FieldDescription id="col-currency-hint">Three letters, such as USD or EUR.</FieldDescription>
        </Field>
      )}
      <FieldError>{error}</FieldError>
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
        <Field orientation="horizontal">
          <Checkbox id="delete-with-outputs" checked={withOutputs} onCheckedChange={(v) => setWithOutputs(v === true)} />
          <FieldLabel htmlFor="delete-with-outputs">Also delete the output columns it fills</FieldLabel>
        </Field>
      )}
      <FieldError>{error}</FieldError>
    </Shell>
  );
}

function DedupeDialog({ column, dedupe, onClose }: { column: GridColumn; dedupe: Props["dedupe"]; onClose: () => void }) {
  // The hook reloads the table, so this dialog does not call onChanged.
  const { busy, error, run } = useRequest(onClose, async () => {});
  const submit = () =>
    run(
      () => dedupe(column.id),
      (data) => {
        const n = data.deleted;
        toast.success(n === 0 ? "No duplicates found." : `Removed ${countOf(n, "duplicate row")}.`);
      },
    );
  return (
    <Shell
      title={`Remove duplicates in "${column.name}"?`}
      description="Rows that repeat an earlier row's value in this column are deleted. The first row stays and blank values are kept. This cannot be undone."
      onClose={onClose}
      footer={<Footer onClose={onClose} busy={busy} label="Remove duplicates" onSubmit={submit} destructive />}
    >
      <FieldError>{error}</FieldError>
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
      (data) => toast.success(`Created ${countOf(data.columnsCreated ?? 0, "column")} from ${countOf(data.rowsUpdated ?? 0, "row")}.`),
    );
  return (
    <Shell
      title={`Text to columns: "${column.name}"`}
      description="Splits each value at the separator and puts the parts into new columns to the right."
      onClose={onClose}
      footer={<Footer onClose={onClose} busy={busy} label="Split" onSubmit={submit} />}
    >
      <Field>
        <FieldLabel htmlFor="split-delim">Separator</FieldLabel>
        <ItemSelect id="split-delim" items={DELIMITERS} value={delimiter} onChange={setDelimiter} className="w-48" />
      </Field>
      <FieldError>{error}</FieldError>
    </Shell>
  );
}

function FilterDialog({ column, view, saveView, onClose }: { column: GridColumn; view: TableView; saveView: (v: TableView) => Promise<boolean>; onClose: () => void }) {
  const [operator, setOperator] = useState<FilterOperator>("contains");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const items = FILTER_OPERATORS.filter((o) => o !== "runFailed" || RUN_FILLED_TYPES.has(column.type)).map((o) => ({ value: o, label: OPERATOR_LABELS[o] }));
  const submit = async () => {
    setBusy(true);
    const ok = await saveView(addFilter(view, { columnKey: column.key, operator, ...(operatorNeedsValue(operator) ? { value } : {}) }));
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Shell title={`Filter "${column.name}"`} description="The filter is saved for you and only changes what you see. Owners and admins can save the current view as the default for everyone." onClose={onClose} footer={<Footer onClose={onClose} busy={busy} label="Add filter" onSubmit={submit} />}>
      <form onSubmit={(e) => (e.preventDefault(), void submit())}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="filter-op">Condition</FieldLabel>
            <ItemSelect id="filter-op" items={items} value={operator} onChange={(v) => setOperator(v as FilterOperator)} />
          </Field>
          {operatorNeedsValue(operator) && (
            <Field>
              <FieldLabel htmlFor="filter-value">Value</FieldLabel>
              <Input id="filter-value" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
            </Field>
          )}
        </FieldGroup>
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
      <form onSubmit={(e) => (e.preventDefault(), submit())}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="new-col-name">Name</FieldLabel>
            <Input id="new-col-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={120} placeholder="Column name" />
          </Field>
          <Field>
            <FieldLabel htmlFor="new-col-type">Type</FieldLabel>
            <ItemSelect id="new-col-type" items={EDITABLE_TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} value={type} onChange={setType} className="w-56" />
          </Field>
          <FieldError>{error}</FieldError>
        </FieldGroup>
        <button type="submit" hidden />
      </form>
    </Shell>
  );
}
