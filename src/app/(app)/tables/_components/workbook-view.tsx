"use client";

import { ArrowRightLeftIcon, CopyIcon, FileTextIcon, FolderInputIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { NameInput } from "@/components/shell/editable-title";
import { ErrorState } from "@/components/shell/error-state";
import { PageHeader } from "@/components/shell/page-header";
import { PageSkeleton } from "@/components/shell/page-skeleton";
import { ScrollCue } from "@/components/shell/scroll-cue";
import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/components/ui/utils";
import { gridRequest, gridUrl } from "../_lib/data/client";
import { MoveDialog, type FolderNode } from "./move-dialog";
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

type Action =
  | { kind: "deleteTable"; id: string; name: string }
  | { kind: "describeTable"; id: string; name: string; description: string }
  | { kind: "moveTable"; id: string; name: string }
  | { kind: "moveWorkbook"; folders: FolderNode[] }
  | { kind: "deleteWorkbook" };

/**
 * A workbook: its title, a strip of table tabs (drag or Alt+Arrow to reorder) and the active table's grid. The title and
 * each tab rename in place; the header's More menu holds the workbook's rare actions.
 */
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
  const [editingTab, setEditingTab] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Set once the workbook is deleted: the grid unmounts so it stops asking for tables that are gone.
  const [deleted, setDeleted] = useState(false);
  // Rename from a tab's menu: the menu must not take focus back from the field it opened.
  const renaming = useRef(false);

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

  // The route's metadata names the page "Table"; the browser tab names the open workbook instead, and gets the route's
  // title back when the page goes.
  const workbookName = workbook?.name;
  useEffect(() => {
    if (!workbookName) return;
    const before = document.title;
    document.title = `${workbookName} · MiaSDR`;
    return () => {
      document.title = before;
    };
  }, [workbookName]);

  useEffect(() => {
    if (!editingTab) renaming.current = false;
  }, [editingTab]);

  /** Makes a table under the default name, opens it and puts its tab straight into rename. */
  async function createTable() {
    setCreating(true);
    const res = await gridRequest<{ table: TableTab }>(gridUrl.tables, "POST", { workbookId });
    setCreating(false);
    if (!res.ok || !res.data) return void toast.error(res.error ?? "Could not create the table.");
    await load();
    select(res.data.table.id);
    setEditingTab(res.data.table.id);
  }

  async function renameWorkbook(name: string) {
    const res = await gridRequest(`${gridUrl.workbooks}/${workbookId}`, "PATCH", { name });
    if (!res.ok) return res.error ?? "Could not rename the workbook.";
    setWorkbook((w) => (w ? { ...w, name } : w));
    return null;
  }

  async function renameTable(id: string, name: string) {
    const res = await gridRequest(`${gridUrl.tables}/${id}`, "PATCH", { name });
    if (!res.ok) return res.error ?? "Could not rename the table.";
    setTabs((list) => list.map((t) => (t.id === id ? { ...t, name } : t)));
    return null;
  }

  async function openMove() {
    const res = await gridRequest<{ folders: FolderNode[] }>(gridUrl.folders, "GET");
    if (!res.ok || !res.data) return void toast.error(res.error ?? "Could not load the folders.");
    setAction({ kind: "moveWorkbook", folders: res.data.folders });
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
        <div className="page">
          <PageSkeleton shape="table" />
        </div>
      </>
    );
  }
  if (status === "error" || !workbook) {
    return (
      <>
        <PageHeader title="Table" />
        <div className="page">
          <ErrorState
            inline
            title="The workbook did not load"
            reason={error ?? "Could not load the workbook."}
            action={
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" touch onClick={() => void load()}>
                  Try again
                </Button>
                <Link href="/tables" className={buttonVariants({ variant: "outline", touch: true })}>
                  Back to tables
                </Link>
              </div>
            }
          />
        </div>
      </>
    );
  }

  return (
    <div className="flex h-svh min-h-0 flex-col">
      <PageHeader
        title={workbook.name}
        back={{ href: workbook.folderId ? `/tables?folder=${workbook.folderId}` : "/tables", label: "Tables" }}
        rename={{ label: "Workbook name", onSave: renameWorkbook }}
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" touch aria-label="Workbook actions" />}>
              <MoreHorizontalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => void openMove()}>
                <FolderInputIcon /> Move to folder
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setAction({ kind: "deleteWorkbook" })}>
                <Trash2Icon /> Delete workbook
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />

      <div className="border-b px-3 pt-1.5">
        <ScrollCue
          role="tablist"
          aria-label="Tables"
          className="items-end gap-1"
          after={
            <Tooltip>
              <TooltipTrigger
                render={<Button variant="ghost" size="icon-sm" touch aria-label="New table" className="mb-0.5 ml-1 shrink-0" onClick={() => void createTable()} disabled={creating} />}
              >
                <PlusIcon />
              </TooltipTrigger>
              <TooltipContent>New table</TooltipContent>
            </Tooltip>
          }
        >
          {tabs.map((tab) => {
            const selected = tab.id === activeId;
            const editing = editingTab === tab.id;
            return (
              <div
                key={tab.id}
                role="presentation"
                draggable={!editing}
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
                {editing ? (
                  <span className="px-1.5 py-0.5">
                    <NameInput
                      value={tab.name}
                      label="Table name"
                      onSave={(name) => renameTable(tab.id, name)}
                      onDone={(_saved, end) => {
                        setEditingTab(null);
                        // After Enter or Escape, back to the tab once it renders again in place of the field. A click
                        // elsewhere keeps its focus.
                        if (end === "key") setTimeout(() => document.getElementById(`tab-${tab.id}`)?.focus(), 0);
                      }}
                    />
                  </span>
                ) : (
                  <button
                    type="button"
                    role="tab"
                    id={`tab-${tab.id}`}
                    aria-selected={selected}
                    aria-controls="table-panel"
                    tabIndex={selected ? 0 : -1}
                    className="rounded-t-md px-3 py-1.5 focus-ring max-sm:py-3"
                    onClick={() => select(tab.id)}
                    onDoubleClick={() => setEditingTab(tab.id)}
                    onKeyDown={(e) => {
                      const i = tabs.findIndex((t) => t.id === tab.id);
                      if (e.key === "F2") {
                        e.preventDefault();
                        setEditingTab(tab.id);
                        return;
                      }
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
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label={`Actions for ${tab.name}`}
                    // Shown on the open tab; on the others it waits for hover or focus, and a touch screen offers it on the open tab only.
                    className={cn(
                      "mr-1 flex items-center justify-center rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-ring max-sm:size-11",
                      editing && "hidden",
                      !selected && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:hidden",
                    )}
                  >
                    <MoreHorizontalIcon className="size-3.5" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="w-44" finalFocus={() => !renaming.current}>
                    <DropdownMenuItem
                      onClick={() => {
                        renaming.current = true;
                        setEditingTab(tab.id);
                      }}
                    >
                      <PencilIcon /> Rename
                      <span className="ml-auto text-xs text-muted-foreground">F2</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setAction({ kind: "describeTable", id: tab.id, name: tab.name, description: tab.description ?? "" })}>
                      <FileTextIcon /> Edit description
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void duplicate(tab.id)}>
                      <CopyIcon /> Duplicate
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={tabs.length === 1} onClick={() => setAction({ kind: "moveTable", id: tab.id, name: tab.name })}>
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
                    <DropdownMenuItem variant="destructive" disabled={tabs.length === 1} onClick={() => setAction({ kind: "deleteTable", id: tab.id, name: tab.name })}>
                      <Trash2Icon /> Delete
                      {tabs.length === 1 && <span className="ml-auto text-xs text-muted-foreground">Only table</span>}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })}
        </ScrollCue>
      </div>

      {tabs.find((t) => t.id === activeId)?.description && (
        <p data-testid="table-description" className="border-b px-3 py-1.5 text-xs whitespace-pre-line text-muted-foreground">
          {tabs.find((t) => t.id === activeId)?.description}
        </p>
      )}

      <div id="table-panel" role="tabpanel" aria-labelledby={activeId ? `tab-${activeId}` : undefined} className="flex min-h-0 flex-1 flex-col">
        {activeId && !deleted && <TableWorkspace key={activeId} tableId={activeId} />}
      </div>

      {action?.kind === "moveWorkbook" && (
        <MoveDialog
          action={{ type: "workbook", id: workbookId, name: workbook.name, current: workbook.folderId }}
          folders={action.folders}
          onSubmit={async (folderId) => {
            const res = await gridRequest(`${gridUrl.workbooks}/${workbookId}`, "PATCH", { folderId });
            if (!res.ok) return res.error ?? "Could not move the workbook.";
            setWorkbook({ ...workbook, folderId });
            toast.success(`Moved "${workbook.name}".`);
            return null;
          }}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === "deleteWorkbook" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setAction(null)}
          title={`Delete workbook "${workbook.name}"?`}
          description="Its tables, rows and run history are deleted. This cannot be undone."
          confirmLabel="Delete workbook"
          cancelLabel="Keep workbook"
          pendingLabel="Deleting…"
          destructive
          onConfirm={async () => {
            const res = await gridRequest(`${gridUrl.workbooks}/${workbookId}`, "DELETE");
            if (!res.ok) throw new Error(res.error ?? "Could not delete the workbook. Try again.");
            setDeleted(true);
            toast.success(`Deleted "${workbook.name}".`);
            router.push(workbook.folderId ? `/tables?folder=${workbook.folderId}` : "/tables");
          }}
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
          cancelLabel="Keep table"
          pendingLabel="Deleting…"
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
