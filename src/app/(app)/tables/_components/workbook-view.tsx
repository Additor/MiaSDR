"use client";

import { ArrowRightLeftIcon, CopyIcon, FileTextIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { gridRequest, gridUrl } from "../_lib/data/client";
import { NameDialog } from "./name-dialog";
import { DescriptionDialog, MoveTableDialog } from "./table-dialogs";
import { TableWorkspace } from "./table-workspace";

interface TableTab {
  id: string;
  name: string;
  position: number;
  description: string | null;
}

interface Workbook {
  id: string;
  name: string;
  folderId: string | null;
}

type Action = { kind: "renameTable"; id: string; name: string } | { kind: "deleteTable"; id: string; name: string } | { kind: "describeTable"; id: string; name: string; description: string } | { kind: "moveTable"; id: string; name: string } | { kind: "renameWorkbook" } | { kind: "newTable" };

/** A workbook: its title, a strip of table tabs (drag or Alt+Arrow to reorder) and the active table's grid. */
export function WorkbookView({ workbookId }: { workbookId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const wanted = params.get("table");
  const [workbook, setWorkbook] = useState<Workbook | null>(null);
  const [tabs, setTabs] = useState<TableTab[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await gridRequest<{ workbook: Workbook; tables: TableTab[] }>(`${gridUrl.workbooks}/${workbookId}`, "GET");
    if (!res.ok || !res.data) {
      setError(res.error);
      setStatus("error");
      return;
    }
    setWorkbook(res.data.workbook);
    setTabs([...res.data.tables].sort((a, b) => a.position - b.position));
    setStatus("ready");
  }, [workbookId]);

  useEffect(() => {
    const handle = setTimeout(() => void load(), 0);
    return () => clearTimeout(handle);
  }, [load]);

  const activeId = tabs.find((t) => t.id === wanted)?.id ?? tabs[0]?.id ?? null;

  const select = useCallback(
    (id: string) => {
      const next = new URLSearchParams(params.toString());
      next.set("table", id);
      router.replace(`${pathname}?${next}`, { scroll: false });
    },
    [params, pathname, router],
  );

  async function reorder(ids: string[]) {
    const previous = tabs;
    const byId = new Map(tabs.map((t) => [t.id, t]));
    setTabs(ids.map((id, i) => ({ ...byId.get(id)!, position: i })));
    const res = await gridRequest(`${gridUrl.workbooks}/${workbookId}/tables/reorder`, "POST", { tableIds: ids });
    if (!res.ok) {
      setTabs(previous);
      toast.error(res.error ?? "Could not reorder the tabs.");
    }
  }

  function moveTab(id: string, delta: -1 | 1) {
    const ids = tabs.map((t) => t.id);
    const i = ids.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void reorder(ids);
  }

  async function createTable(name: string) {
    const res = await gridRequest<{ table: TableTab }>(gridUrl.tables, "POST", { workbookId, name: name || undefined });
    if (!res.ok || !res.data) return res.error ?? "Could not create the table.";
    await load();
    select(res.data.table.id);
    return null;
  }

  async function duplicate(id: string) {
    const res = await gridRequest<{ table: TableTab }>(`${gridUrl.tables}/${id}/duplicate`, "POST");
    if (!res.ok || !res.data) return void toast.error(res.error ?? "Could not duplicate the table.");
    await load();
    select(res.data.table.id);
    toast.success("Table duplicated.");
  }

  if (status === "loading") {
    return (
      <>
        <PageHeader title="Table" />
        <div className="page stack-group">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-[60svh] w-full" />
        </div>
      </>
    );
  }
  if (status === "error" || !workbook) {
    return (
      <>
        <PageHeader title="Table" />
        <div className="page stack-group" role="alert">
          <p className="text-sm text-destructive">{error ?? "Could not load the workbook."}</p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => void load()}>
              Try again
            </Button>
            <Link href="/tables" className="inline-flex h-8 items-center rounded-lg border px-2.5 text-sm hover:bg-muted">
              Back to tables
            </Link>
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="flex h-svh min-h-0 flex-col">
      <PageHeader
        title={workbook.name}
        back={{ href: workbook.folderId ? `/tables?folder=${workbook.folderId}` : "/tables", label: "Tables" }}
        actions={
          <Button variant="ghost" size="icon-sm" aria-label="Rename workbook" onClick={() => setAction({ kind: "renameWorkbook" })}>
            <PencilIcon />
          </Button>
        }
      />

      <div role="tablist" aria-label="Tables" className="flex items-center gap-1 overflow-x-auto border-b px-3 pt-1.5">
        {tabs.map((tab) => {
          const selected = tab.id === activeId;
          return (
            <div
              key={tab.id}
              draggable
              onDragStart={(e) => {
                setDragging(tab.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => dragging && dragging !== tab.id && e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (!dragging || dragging === tab.id) return;
                const ids = tabs.map((t) => t.id).filter((id) => id !== dragging);
                ids.splice(ids.indexOf(tab.id), 0, dragging);
                setDragging(null);
                void reorder(ids);
              }}
              onDragEnd={() => setDragging(null)}
              className={cn("group flex shrink-0 items-center rounded-t-md border border-b-0 text-sm", selected ? "bg-background font-medium" : "bg-muted/40 text-muted-foreground", dragging === tab.id && "opacity-50")}
            >
              <button
                type="button"
                role="tab"
                id={`tab-${tab.id}`}
                aria-selected={selected}
                aria-controls="table-panel"
                tabIndex={selected ? 0 : -1}
                className="rounded-t-md px-3 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => select(tab.id)}
                onKeyDown={(e) => {
                  const i = tabs.findIndex((t) => t.id === tab.id);
                  if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
                    e.preventDefault();
                    moveTab(tab.id, e.key === "ArrowLeft" ? -1 : 1);
                    return;
                  }
                  const target = e.key === "ArrowRight" ? tabs[i + 1] : e.key === "ArrowLeft" ? tabs[i - 1] : e.key === "Home" ? tabs[0] : e.key === "End" ? tabs[tabs.length - 1] : undefined;
                  if (target) {
                    e.preventDefault();
                    select(target.id);
                    document.getElementById(`tab-${target.id}`)?.focus();
                  }
                }}
              >
                {tab.name}
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger aria-label={`Actions for ${tab.name}`} className="mr-1 rounded p-0.5 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                  <MoreHorizontalIcon className="size-3.5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-44">
                  <DropdownMenuItem onClick={() => setAction({ kind: "renameTable", id: tab.id, name: tab.name })}>
                    <PencilIcon /> Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setAction({ kind: "describeTable", id: tab.id, name: tab.name, description: tab.description ?? "" })}>
                    <FileTextIcon /> Edit description
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void duplicate(tab.id)}>
                    <CopyIcon /> Duplicate
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={tabs.length === 1} title={tabs.length === 1 ? "A workbook keeps at least one table, so its only table cannot move." : undefined} onClick={() => setAction({ kind: "moveTable", id: tab.id, name: tab.name })}>
                    <ArrowRightLeftIcon /> Move to workbook
                    {tabs.length === 1 && <span className="ml-auto text-xs text-muted-foreground">Only table</span>}
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={tabs[0]?.id === tab.id} onClick={() => moveTab(tab.id, -1)}>
                    Move left
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={tabs[tabs.length - 1]?.id === tab.id} onClick={() => moveTab(tab.id, 1)}>
                    Move right
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" disabled={tabs.length === 1} title={tabs.length === 1 ? "A workbook keeps at least one table, so its only table cannot be deleted." : undefined} onClick={() => setAction({ kind: "deleteTable", id: tab.id, name: tab.name })}>
                    <Trash2Icon /> Delete
                    {tabs.length === 1 && <span className="ml-auto text-xs text-muted-foreground">Only table</span>}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        })}
        <Button variant="ghost" size="icon-sm" aria-label="New table" onClick={() => setAction({ kind: "newTable" })}>
          <PlusIcon />
        </Button>
      </div>

      {tabs.find((t) => t.id === activeId)?.description && (
        <p data-testid="table-description" className="border-b px-3 py-1.5 text-xs whitespace-pre-line text-muted-foreground">
          {tabs.find((t) => t.id === activeId)?.description}
        </p>
      )}

      <div id="table-panel" role="tabpanel" aria-labelledby={activeId ? `tab-${activeId}` : undefined} className="flex min-h-0 flex-1 flex-col">
        {activeId && <TableWorkspace key={activeId} tableId={activeId} />}
      </div>

      {action?.kind === "newTable" && <NameDialog title="New table" submitLabel="Create table" onSubmit={createTable} onClose={() => setAction(null)} />}
      {action?.kind === "renameWorkbook" && (
        <NameDialog
          title="Rename workbook"
          initial={workbook.name}
          submitLabel="Rename"
          onSubmit={async (name) => {
            const res = await gridRequest(`${gridUrl.workbooks}/${workbookId}`, "PATCH", { name });
            if (!res.ok) return res.error ?? "Could not rename.";
            await load();
            return null;
          }}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === "renameTable" && (
        <NameDialog
          title="Rename table"
          initial={action.name}
          submitLabel="Rename"
          onSubmit={async (name) => {
            const res = await gridRequest(`${gridUrl.tables}/${action.id}`, "PATCH", { name });
            if (!res.ok) return res.error ?? "Could not rename.";
            await load();
            return null;
          }}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === "describeTable" && (
        <DescriptionDialog
          tableName={action.name}
          initial={action.description}
          onSubmit={async (description) => {
            const res = await gridRequest(`${gridUrl.tables}/${action.id}`, "PATCH", { description });
            if (!res.ok) return res.error ?? "Could not save the description.";
            await load();
            return null;
          }}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === "moveTable" && (
        <MoveTableDialog
          tableName={action.name}
          currentWorkbookId={workbookId}
          onSubmit={async (destination, destinationName) => {
            const res = await gridRequest(`${gridUrl.tables}/${action.id}`, "PATCH", { workbookId: destination });
            if (!res.ok) return res.error ?? "Could not move the table.";
            toast.success(`Moved "${action.name}" to "${destinationName}".`);
            // Follow the table. The old ?table= names a table this workbook no longer holds, so staying here would fall back to its first tab.
            router.push(`/tables/${destination}?table=${action.id}`);
            return null;
          }}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === "deleteTable" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setAction(null)}
          title={`Delete table "${action.name}"?`}
          description="Its columns, rows and run history are deleted. This cannot be undone."
          confirmLabel="Delete table"
          pendingLabel="Deleting..."
          destructive
          onConfirm={async () => {
            const res = await gridRequest(`${gridUrl.tables}/${action.id}`, "DELETE");
            if (!res.ok) throw new Error(res.error ?? "Could not delete the table. Try again.");
            await load();
          }}
        />
      )}
    </div>
  );
}
