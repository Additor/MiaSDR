"use client";

import {
  ArrowDownAZIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpAZIcon,
  ChevronDownIcon,
  CopyIcon,
  CopyMinusIcon,
  EyeOffIcon,
  FilterIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SettingsIcon,
  SplitIcon,
  Trash2Icon,
  TypeIcon,
  XIcon,
} from "lucide-react";
import { isStaticColumnType } from "@/contexts/grid/domain/column-types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EDITABLE_TYPE_OPTIONS, RUNNER_TYPES_WITH_RUN } from "../_lib/view/format";
import { isColumnActionOffered, pinBlockedReason, type ColumnAction } from "../_lib/edit/column-actions";
import type { GridColumn } from "../_lib/data/types";

export type { ColumnAction } from "../_lib/edit/column-actions";

interface Props {
  column: GridColumn;
  index: number;
  count: number;
  sort: "asc" | "desc" | null;
  /** Whether this column is pinned and how many are pinned in all. The grid passes them once pins render. */
  pinned?: boolean;
  pinCount?: number;
  /** A runner column's results across the loaded rows, shown at the top of its menu. */
  summary?: string | null;
  onAction: (column: GridColumn, action: ColumnAction) => void;
}

/** The menu behind a column header: rename, type, config, sort, filter, hide, dedupe, split and delete. */
export function ColumnMenu({ column, index, count, sort, pinned = false, pinCount = 0, summary, onAction }: Props) {
  const act = (action: ColumnAction) => () => onAction(column, action);
  const offered = (kind: ColumnAction["kind"]) => isColumnActionOffered(kind, { column, pinned, pinCount });
  const pinBlocked = pinBlockedReason({ pinned, pinCount });
  const isStatic = isStaticColumnType(column.type);
  const hasConfig = isStatic ? ["select", "multiselect", "currency"].includes(column.type) : ["formula", "ai", "enrichment", "waterfall"].includes(column.type);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Column menu for ${column.name}`}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-ring"
      >
        <ChevronDownIcon className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {summary && (
          <DropdownMenuGroup>
            <DropdownMenuLabel className="tabular-nums">{summary}</DropdownMenuLabel>
            <DropdownMenuSeparator />
          </DropdownMenuGroup>
        )}
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={act({ kind: "rename" })}>
            <PencilIcon /> Rename
          </DropdownMenuItem>
          {isStatic && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <TypeIcon /> Change type
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-44">
                {EDITABLE_TYPE_OPTIONS.map((option) => (
                  <DropdownMenuItem key={option.value} disabled={option.value === column.type} onClick={act({ kind: "type", type: option.value })}>
                    {option.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          {hasConfig && (
            <DropdownMenuItem onClick={act({ kind: "config" })}>
              <SettingsIcon /> {isStatic ? "Edit options" : "Edit settings"}
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={act({ kind: "sort", direction: "asc" })}>
            <ArrowUpAZIcon /> Sort ascending {sort === "asc" && "(on)"}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={act({ kind: "sort", direction: "desc" })}>
            <ArrowDownAZIcon /> Sort descending {sort === "desc" && "(on)"}
          </DropdownMenuItem>
          {sort && (
            <DropdownMenuItem onClick={act({ kind: "sort", direction: null })}>
              <XIcon /> Clear sort
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={act({ kind: "filter" })}>
            <FilterIcon /> Filter
          </DropdownMenuItem>
          <DropdownMenuItem onClick={act({ kind: "hide" })}>
            <EyeOffIcon /> Hide column
          </DropdownMenuItem>
          {offered("pin") && (
            <DropdownMenuItem onClick={act({ kind: "pin" })}>
              <PinIcon /> Pin column
            </DropdownMenuItem>
          )}
          {pinBlocked && (
            <DropdownMenuItem disabled title={`${pinBlocked}. Unpin one first.`}>
              <PinIcon /> <span className="flex min-w-0 flex-col leading-tight">Pin column<span className="text-xs text-muted-foreground">{pinBlocked}</span></span>
            </DropdownMenuItem>
          )}
          {offered("unpin") && (
            <DropdownMenuItem onClick={act({ kind: "unpin" })}>
              <PinOffIcon /> Unpin column
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={act({ kind: "insert", side: "left" })}>Insert column left</DropdownMenuItem>
          <DropdownMenuItem onClick={act({ kind: "insert", side: "right" })}>Insert column right</DropdownMenuItem>
          <DropdownMenuItem disabled={index === 0} onClick={act({ kind: "move", side: "left" })}>
            <ArrowLeftIcon /> Move left
          </DropdownMenuItem>
          <DropdownMenuItem disabled={index >= count - 1} onClick={act({ kind: "move", side: "right" })}>
            <ArrowRightIcon /> Move right
          </DropdownMenuItem>
          {offered("duplicate") && (
            <DropdownMenuItem onClick={act({ kind: "duplicate" })}>
              <CopyIcon /> Duplicate column
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
        {(RUNNER_TYPES_WITH_RUN.has(column.type) || column.type === "formula") && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {RUNNER_TYPES_WITH_RUN.has(column.type) && (
                <>
                  <DropdownMenuItem onClick={act({ kind: "run" })}>
                    <PlayIcon /> Run column
                  </DropdownMenuItem>
                  {offered("runFirstN") && (
                    <DropdownMenuItem onClick={act({ kind: "runFirstN", count: 10 })}>
                      <PlayIcon /> Run first 10 rows
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={act({ kind: "retry" })}>
                    <RotateCcwIcon /> Retry failed cells
                  </DropdownMenuItem>
                </>
              )}
              {column.type === "formula" && (
                <DropdownMenuItem onClick={act({ kind: "recalculate" })}>
                  <RefreshCwIcon /> Recalculate
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={act({ kind: "dedupe" })}>
            <CopyMinusIcon /> Remove duplicate rows
          </DropdownMenuItem>
          <DropdownMenuItem onClick={act({ kind: "textToColumns" })}>
            <SplitIcon /> Text to columns
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={act({ kind: "delete" })}>
          <Trash2Icon /> Delete column
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
