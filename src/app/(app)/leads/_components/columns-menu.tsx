"use client";

import { Columns3Icon } from "lucide-react";
import { createContext, useContext, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { columnsCookie, COLUMN_LABELS, OPTIONAL_COLUMNS, toggleColumn, type OptionalColumn } from "../_lib/list-columns";

const ColumnsContext = createContext<{ columns: OptionalColumn[]; change: (next: OptionalColumn[]) => void } | null>(null);

/**
 * The person's column choice, shared by the Columns menu in the toolbar and the table under it. Each change goes to
 * their cookie, which the server reads on the next render.
 */
export function LeadColumnsProvider({ initial, userId, children }: { initial: OptionalColumn[]; userId: string; children: ReactNode }) {
  const [columns, setColumns] = useState(initial);
  const change = (next: OptionalColumn[]) => {
    setColumns(next);
    document.cookie = columnsCookie(userId, next);
  };
  return <ColumnsContext.Provider value={{ columns, change }}>{children}</ColumnsContext.Provider>;
}

export function useLeadColumns() {
  const value = useContext(ColumnsContext);
  if (!value) throw new Error("useLeadColumns needs a LeadColumnsProvider");
  return value;
}

/** Picks which optional columns the people list shows. Name always shows. */
export function ColumnsMenu() {
  const { columns, change: onChange } = useLeadColumns();
  const hidden = OPTIONAL_COLUMNS.length - columns.length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="max-sm:h-11 max-sm:px-4" />}>
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
