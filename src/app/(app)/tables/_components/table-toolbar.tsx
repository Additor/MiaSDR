"use client";

import { BotIcon, ChevronDownIcon, Columns3Icon, DownloadIcon, ListFilterIcon, Loader2Icon, PlayIcon, PlusIcon, SearchIcon, SendIcon, SigmaIcon, SparklesIcon, UploadIcon, Redo2Icon, Undo2Icon } from "lucide-react";
import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { GridColumn } from "../_lib/data/types";
import { RunProgress } from "./run-controls";

export type AddColumnKind = "column" | "formula" | "enrichment" | "ai";

type Progress = ComponentProps<typeof RunProgress>;

interface Props {
  tableId: string;
  columns: GridColumn[];
  hidden: ReadonlySet<string>;
  search: string;
  onSearch: (value: string) => void;
  busy: boolean;
  saving: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** True when the table has a column that runs (enrichment, waterfall or AI). */
  runnable: boolean;
  autoRun: boolean;
  total: number;
  unfilteredTotal: number;
  jobs: Progress["jobs"];
  activeJobs: number;
  onAddColumn: (kind: AddColumnKind) => void;
  onAddRow: () => void;
  /** Opens the "Add rows" dialog (1 to 1,000 blank rows). */
  onAddRows: () => void;
  onImport: () => void;
  onExport: () => void;
  onPush: () => void;
  onRun: () => void;
  onToggleAutoRun: (next: boolean) => void;
  onToggleHidden: (columnKey: string, hide: boolean) => void;
  /** Opens the filter and sort panel. `activeFilters` counts conditions that narrow rows; muted ones do not count. */
  onOpenFilters: () => void;
  activeFilters: number;
  sortCount: number;
  onJobsChanged: () => void;
  /** Filters the grid to the rows whose run failed. */
  onShowFailed?: () => void;
}

/** The row of controls above the grid: search, add, import and export, column visibility, run, row count. */
export function TableToolbar(props: Props) {
  const { columns, hidden } = props;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input aria-label="Search rows" placeholder="Search rows" className="w-56 pl-7" value={props.search} onChange={(e) => props.onSearch(e.target.value)} />
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
          <PlusIcon /> Add column <ChevronDownIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-52">
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => props.onAddColumn("column")}>
              <Columns3Icon /> Column
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => props.onAddColumn("formula")}>
              <SigmaIcon /> Formula
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => props.onAddColumn("enrichment")}>
              <SparklesIcon /> Enrichment
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => props.onAddColumn("ai")}>
              <BotIcon /> AI column
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button variant="outline" size="sm" onClick={props.onAddRow} disabled={props.busy}>
        <PlusIcon /> Add row
      </Button>
      <Button variant="outline" size="sm" onClick={props.onAddRows} disabled={props.busy}>
        <PlusIcon /> Add rows...
      </Button>
      <Button variant="outline" size="sm" onClick={props.onImport}>
        <UploadIcon /> Import
      </Button>
      <Button variant="outline" size="sm" onClick={props.onExport} disabled={props.busy}>
        <DownloadIcon /> Export
      </Button>
      <Button variant="outline" size="sm" onClick={props.onPush}>
        <SendIcon /> Push to campaign
      </Button>

      <Button variant="outline" size="sm" onClick={props.onOpenFilters}>
        <ListFilterIcon /> Filter and sort{props.activeFilters + props.sortCount > 0 ? ` (${[props.activeFilters > 0 ? `${props.activeFilters} filter${props.activeFilters === 1 ? "" : "s"}` : "", props.sortCount > 0 ? `${props.sortCount} sort${props.sortCount === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ")})` : ""}
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
          <Columns3Icon /> Columns{hidden.size > 0 ? ` (${hidden.size} hidden)` : ""}
        </DropdownMenuTrigger>
        <DropdownMenuContent className="max-h-80 w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Show columns</DropdownMenuLabel>
            {columns.map((c) => (
              <DropdownMenuCheckboxItem key={c.id} checked={!hidden.has(c.key)} onCheckedChange={(checked) => props.onToggleHidden(c.key, !checked)}>
                {c.name}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {props.runnable && (
        <>
          <Button size="sm" onClick={props.onRun}>
            <PlayIcon /> Run
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Run settings" />}>
              <ChevronDownIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56">
              <DropdownMenuCheckboxItem checked={props.autoRun} onCheckedChange={(v) => props.onToggleAutoRun(v)}>
                Auto-run new and edited rows
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
      <RunProgress tableId={props.tableId} jobs={props.jobs} activeJobs={props.activeJobs} onChanged={props.onJobsChanged} onShowFailed={props.onShowFailed} />

      <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
        <Button variant="ghost" size="icon-sm" aria-label="Undo" title="Undo (Ctrl+Z or Cmd+Z)" disabled={!props.canUndo} onClick={props.onUndo}>
          <Undo2Icon />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Redo" title="Redo (Shift+Ctrl+Z or Shift+Cmd+Z)" disabled={!props.canRedo} onClick={props.onRedo}>
          <Redo2Icon />
        </Button>
        <div className="flex items-center gap-2" aria-live="polite">
          {props.saving && (
            <span className="flex items-center gap-1">
              <Loader2Icon className="size-3 animate-spin" /> Saving
            </span>
          )}
          <span>
            {props.total.toLocaleString("en-US")} row{props.total === 1 ? "" : "s"}
            {props.total !== props.unfilteredTotal ? ` of ${props.unfilteredTotal.toLocaleString("en-US")}` : ""}
          </span>
        </div>
      </div>
    </div>
  );
}
