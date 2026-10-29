"use client";

import { BotIcon, ChevronDownIcon, Columns3Icon, DownloadIcon, PlayIcon, PlusIcon, Rows3Icon, SearchIcon, SendIcon, SigmaIcon, SparklesIcon, UploadIcon, Redo2Icon, Undo2Icon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Spinner } from "@/components/shell/spinner";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { countOf, formatCount } from "@/shared/format-number";
import { OUTCOMES } from "../_lib/data/outcomes";
import type { GridColumn } from "../_lib/data/types";
import { RunProgress } from "./run-controls";

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
  onAddColumn: (kind: "column" | "formula") => void;
  /** Opens the enrichment dialog on one outcome, or on its outcome tiles when none is given. */
  onEnrich: (outcome?: string) => void;
  onAddAi: () => void;
  onAddRow: () => void;
  /** Opens the "Add rows" dialog (1 to 1,000 blank rows). */
  onAddRows: () => void;
  onImport: () => void;
  onExport: () => void;
  onPush: () => void;
  onRun: () => void;
  onToggleAutoRun: (next: boolean) => void;
  onToggleHidden: (columnKey: string, hide: boolean) => void;
  /** The Filter and Sort popovers. */
  viewControls: ReactNode;
  onJobsChanged: () => void;
  /** Filters the grid to the rows whose run failed. */
  onShowFailed?: () => void;
}

/**
 * The row of controls above the grid, in two groups. On the left, what you see: search, Filter, Sort, columns and
 * the row count. On the right, what you do, ending on the one filled button: Add, Push to campaign, Enrich, then Run
 * once the table has a column that runs. Enrich is filled until then. Push and Export share one group: the two ways rows
 * leave the table. On a phone the left group takes the first line.
 */
export function TableToolbar(props: Props) {
  const { columns, hidden } = props;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex min-w-0 items-center gap-2 max-sm:w-full">
        <div className="relative min-w-0 max-sm:flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search rows" placeholder="Search rows" className="w-56 pl-7 max-sm:w-full" value={props.search} onChange={(e) => props.onSearch(e.target.value)} />
        </div>
        {props.viewControls}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
            <Columns3Icon /> <span className="max-sm:sr-only">Columns</span>
            {hidden.size > 0 && (
              <>
                <span className="sm:hidden">{hidden.size}</span>
                <span className="max-sm:sr-only"> ({hidden.size} hidden)</span>
              </>
            )}
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
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
        {props.saving && (
          <span className="flex items-center gap-1">
            <Spinner className="size-3" /> Saving
          </span>
        )}
        <span className="tabular-nums">
          {countOf(props.total, "row")}
          {props.total !== props.unfilteredTotal ? ` of ${formatCount(props.unfilteredTotal)}` : ""}
        </span>
      </div>
      <RunProgress tableId={props.tableId} jobs={props.jobs} activeJobs={props.activeJobs} onChanged={props.onJobsChanged} onShowFailed={props.onShowFailed} />

      <div className="ml-auto flex items-center gap-2">
        {/* The grid answers Ctrl or Cmd+Z itself; the buttons are for a mouse, so a phone leaves them out. */}
        <div className="flex items-center max-sm:hidden">
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Undo" disabled={!props.canUndo} onClick={props.onUndo} />}>
              <Undo2Icon />
            </TooltipTrigger>
            <TooltipContent>Undo (Ctrl+Z or Cmd+Z)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Redo" disabled={!props.canRedo} onClick={props.onRedo} />}>
              <Redo2Icon />
            </TooltipTrigger>
            <TooltipContent>Redo (Shift+Ctrl+Z or Shift+Cmd+Z)</TooltipContent>
          </Tooltip>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" aria-label="Add" />}>
            <PlusIcon /> <span className="max-sm:sr-only">Add</span> <ChevronDownIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Columns</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => props.onAddColumn("column")}>
                <Columns3Icon /> Column
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => props.onAddColumn("formula")}>
                <SigmaIcon /> Formula
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Rows</DropdownMenuLabel>
              <DropdownMenuItem onClick={props.onAddRow} disabled={props.busy}>
                <PlusIcon /> Add row
              </DropdownMenuItem>
              <DropdownMenuItem onClick={props.onAddRows} disabled={props.busy}>
                <Rows3Icon /> Add rows…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={props.onImport}>
                <UploadIcon /> Import file
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <ButtonGroup>
          <Button variant="outline" size="sm" onClick={props.onPush}>
            <SendIcon /> <span className="max-sm:sr-only">Push to campaign</span>
          </Button>
          <Tooltip>
            <TooltipTrigger render={<Button variant="outline" size="icon-sm" aria-label="Export CSV" onClick={props.onExport} disabled={props.busy} />}>
              <DownloadIcon />
            </TooltipTrigger>
            <TooltipContent>Export CSV</TooltipContent>
          </Tooltip>
        </ButtonGroup>

        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant={props.runnable ? "outline" : "default"} size="sm" />}>
            <SparklesIcon /> Enrich <ChevronDownIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Add a column that fills itself</DropdownMenuLabel>
              {OUTCOMES.map((o) => (
                <DropdownMenuItem key={o.actionKey} onClick={() => props.onEnrich(o.actionKey)} className="flex-col items-start gap-0">
                  {o.label}
                  <span className="text-xs text-muted-foreground">{o.fills}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={props.onAddAi}>
                <BotIcon /> Ask AI about each row
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => props.onEnrich()}>
                <SparklesIcon /> All enrichments…
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {props.runnable && (
          <ButtonGroup>
            <Button size="sm" onClick={props.onRun} className="border-r-primary-foreground/25">
              <PlayIcon /> Run
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button size={props.autoRun ? "sm" : "icon-sm"} aria-label={props.autoRun ? "Run options, auto-run is on" : "Run options"} />}>
                {props.autoRun && <span className="text-xs">Auto-run on</span>}
                <ChevronDownIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuCheckboxItem checked={props.autoRun} onCheckedChange={(v) => props.onToggleAutoRun(v)}>
                  Auto-run new and edited rows
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </ButtonGroup>
        )}
      </div>
    </div>
  );
}
