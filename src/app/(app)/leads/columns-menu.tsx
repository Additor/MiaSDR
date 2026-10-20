"use client";

import { Columns3Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { COLUMN_LABELS, OPTIONAL_COLUMNS, toggleColumn, type OptionalColumn } from "./list-columns";

/** Picks which optional columns the people list shows. Name always shows. */
export function ColumnsMenu({ columns, onChange }: { columns: readonly OptionalColumn[]; onChange: (next: OptionalColumn[]) => void }) {
  const hidden = OPTIONAL_COLUMNS.length - columns.length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
        <Columns3Icon aria-hidden /> Columns{hidden > 0 ? ` (${hidden} hidden)` : ""}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56" align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Show columns</DropdownMenuLabel>
          {OPTIONAL_COLUMNS.map((column) => (
            <DropdownMenuCheckboxItem key={column} checked={columns.includes(column)} onCheckedChange={(checked) => onChange(toggleColumn(columns, column, checked))}>
              {COLUMN_LABELS[column]}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
