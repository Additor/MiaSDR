"use client";

import { FolderIcon, FolderPlusIcon, MoreHorizontalIcon, PlusIcon, SearchIcon, Table2Icon, UploadIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { RowLink, rowLinkClasses } from "@/components/shell/row-link";
import { Time } from "@/components/shell/time";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { gridRequest, gridUrl } from "../_lib/data/client";
import type { FolderSummary, WorkbookSummary } from "../_lib/data/types";
import { Choice, ErrorText, Field } from "./form-bits";
import { ImportWizard } from "./import-wizard";
import { NameDialog } from "./name-dialog";

interface FolderNode {
  id: string;
  name: string;
  parentId: string | null;
}

type Action =
  | { kind: "newFolder" }
  | { kind: "newWorkbook" }
  | { kind: "rename"; type: "folder" | "workbook"; id: string; name: string }
  | { kind: "move"; type: "folder" | "workbook"; id: string; name: string; current: string | null }
  | { kind: "delete"; type: "folder" | "workbook"; id: string; name: string };

const ROOT = "__root__";
const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

/** Workbook and folder browser: create, rename, move, delete and search. */
export function TablesBrowser() {
  const params = useSearchParams();
  const router = useRouter();
  const folderId = params.get("folder");
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [workbooks, setWorkbooks] = useState<WorkbookSummary[]>([]);
  const [path, setPath] = useState<Array<{ id: string; name: string }>>([]);
  const [allFolders, setAllFolders] = useState<FolderNode[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  // A workbook made from a file: it exists before the wizard shows the mapping, and goes away again if the person cancels.
  const [fromFile, setFromFile] = useState<{ file: File; workbookId: string; tableId: string } | null>(null);
  const fromFileInput = useRef<HTMLInputElement>(null);
  const fromFileImported = useRef(false);

  const load = useCallback(async () => {
    const [everyFolder, content] = await Promise.all([
      gridRequest<{ folders: FolderNode[] }>(gridUrl.folders, "GET"),
      folderId
        ? gridRequest<{ folders: FolderSummary[]; workbooks: WorkbookSummary[]; path: Array<{ id: string; name: string }> }>(`${gridUrl.folders}/${folderId}`, "GET")
        : Promise.all([gridRequest<{ folders: FolderSummary[] }>(`${gridUrl.folders}?parent=root`, "GET"), gridRequest<{ workbooks: WorkbookSummary[] }>(`${gridUrl.workbooks}?folder=root`, "GET")]).then(([f, w]) =>
            f.ok && w.ok && f.data && w.data ? { ok: true as const, error: null, data: { folders: f.data.folders, workbooks: w.data.workbooks, path: [] } } : { ok: false as const, error: f.error ?? w.error, data: null },
          ),
    ]);
    if (everyFolder.ok && everyFolder.data) setAllFolders(everyFolder.data.folders);
    if (!content.ok || !content.data) {
      setError(content.error);
      setStatus("error");
      return;
    }
    setFolders(content.data.folders);
    setWorkbooks(content.data.workbooks);
    setPath(content.data.path);
    setError(null);
    setStatus("ready");
  }, [folderId]);

  useEffect(() => {
    const handle = setTimeout(() => void load(), 0);
    return () => clearTimeout(handle);
  }, [load]);

  // Search covers every folder and workbook, not just this level.
  const [everyWorkbook, setEveryWorkbook] = useState<WorkbookSummary[] | null>(null);
  useEffect(() => {
    if (!query.trim()) return;
    let cancelled = false;
    void gridRequest<{ workbooks: WorkbookSummary[] }>(gridUrl.workbooks, "GET").then((res) => {
      if (!cancelled && res.ok && res.data) setEveryWorkbook(res.data.workbooks);
    });
    return () => {
      cancelled = true;
    };
  }, [query, workbooks]);

  const q = query.trim().toLowerCase();
  const shownFolders = q ? allFolders.filter((f) => f.name.toLowerCase().includes(q)).map((f) => folders.find((x) => x.id === f.id) ?? { ...f, folderCount: 0, workbookCount: 0 }) : folders;
  const shownWorkbooks = q ? (everyWorkbook ?? workbooks).filter((w) => w.name.toLowerCase().includes(q)) : workbooks;
  const folderName = useMemo(() => new Map(allFolders.map((f) => [f.id, f.name])), [allFolders]);

  const href = (id: string | null) => (id ? `/tables?folder=${id}` : "/tables");

  async function mutate(call: Promise<{ ok: boolean; error: string | null }>): Promise<string | null> {
    const res = await call;
    if (!res.ok) return res.error ?? "Something went wrong.";
    await load();
    return null;
  }

  async function createWorkbook(name: string) {
    const res = await gridRequest<{ workbook: { id: string } }>(gridUrl.workbooks, "POST", { name: name || undefined, folderId: folderId ?? null });
    if (!res.ok || !res.data) return res.error ?? "Could not create the workbook.";
    router.push(`/tables/${res.data.workbook.id}`);
    return null;
  }

  async function startFromFile(file: File) {
    const name = file.name.replace(/\.[^.]+$/, "").trim() || "Imported workbook";
    const res = await gridRequest<{ workbook: { id: string }; table: { id: string } }>(gridUrl.workbooks, "POST", { name, folderId: folderId ?? null });
    if (!res.ok || !res.data) return void toast.error(res.error ?? "Could not create the workbook.");
    fromFileImported.current = false;
    setFromFile({ file, workbookId: res.data.workbook.id, tableId: res.data.table.id });
  }

  async function finishFromFile() {
    const made = fromFile;
    setFromFile(null);
    if (!made) return;
    if (fromFileImported.current) return void router.push(`/tables/${made.workbookId}`);
    // Cancelled before the import: the empty workbook would only clutter the list.
    await gridRequest(`${gridUrl.workbooks}/${made.workbookId}`, "DELETE");
    await load();
  }

  // The folder path lives in the top bar: the open folder is the title and its parent is the back step, so the page
  // carries one breadcrumb. Deeper ancestors are one Back away.
  const current = path.at(-1);
  const parent = path.at(-2);
  return (
    <>
      <PageHeader title={current?.name ?? "Tables"} back={current ? { href: href(parent?.id ?? null), label: parent?.name ?? "Tables" } : undefined} />
      <div className="page stack-group">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label="Search workbooks and folders" placeholder="Search workbooks and folders" className="w-72 pl-7" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <span className="ml-auto flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setAction({ kind: "newFolder" })}>
              <FolderPlusIcon /> New folder
            </Button>
            <input
              ref={fromFileInput}
              type="file"
              accept=".csv,.xlsx,text/csv"
              className="sr-only"
              aria-label="Spreadsheet file to start from"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void startFromFile(file);
              }}
            />
            <Button variant="outline" onClick={() => fromFileInput.current?.click()}>
              <UploadIcon /> New from file
            </Button>
            <Button onClick={() => setAction({ kind: "newWorkbook" })}>
              <PlusIcon /> New workbook
            </Button>
          </span>
        </div>

        {status === "loading" && <Skeleton className="h-64 w-full" />}
        {status === "error" && (
          <div role="alert" className="grid gap-2">
            <ErrorText>{error}</ErrorText>
            <div>
              <Button variant="outline" onClick={() => void load()}>
                Try again
              </Button>
            </div>
          </div>
        )}
        {status === "ready" &&
          (shownFolders.length === 0 && shownWorkbooks.length === 0 ? (
            q ? (
              <EmptyState
                title="Nothing matches your search"
                description={`No workbook or folder is named like "${query.trim()}".`}
                action={
                  <Button variant="outline" onClick={() => setQuery("")}>
                    Clear search
                  </Button>
                }
              />
            ) : (
              <EmptyState
                title={folderId ? "This folder is empty" : "No workbooks yet"}
                description="A workbook holds the tables you enrich and push to campaigns. Start a blank one, or build it from a CSV or XLSX file."
                action={
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => setAction({ kind: "newWorkbook" })}>
                      <PlusIcon /> New workbook
                    </Button>
                    <Button variant="outline" onClick={() => fromFileInput.current?.click()}>
                      <UploadIcon /> New from file
                    </Button>
                  </div>
                }
              />
            )
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Contents</TableHead>
                  <TableHead className="hidden sm:table-cell">Updated</TableHead>
                  <TableHead className="w-10">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shownFolders.map((f) => (
                  <TableRow key={f.id} className={rowLinkClasses}>
                    <TableCell>
                      <RowLink href={href(f.id)} className="flex items-center gap-2">
                        <FolderIcon className="size-4 text-muted-foreground" /> {f.name}
                      </RowLink>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {plural(f.folderCount, "folder")}, {plural(f.workbookCount, "workbook")}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell" />
                    <TableCell>
                      <RowMenu
                        label={f.name}
                        onRename={() => setAction({ kind: "rename", type: "folder", id: f.id, name: f.name })}
                        onMove={() => setAction({ kind: "move", type: "folder", id: f.id, name: f.name, current: allFolders.find((x) => x.id === f.id)?.parentId ?? null })}
                        onDelete={() => setAction({ kind: "delete", type: "folder", id: f.id, name: f.name })}
                      />
                    </TableCell>
                  </TableRow>
                ))}
                {shownWorkbooks.map((w) => (
                  <TableRow key={w.id} className={rowLinkClasses}>
                    <TableCell>
                      <RowLink href={`/tables/${w.id}`} className="flex items-center gap-2">
                        <Table2Icon className="size-4 text-muted-foreground" /> {w.name}
                      </RowLink>
                      {q && w.folderId && <p className="pl-6 text-xs text-muted-foreground">in {folderName.get(w.folderId) ?? "a folder"}</p>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {plural(w.tableCount, "table")}, {plural(w.rowCount, "row")}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      <Time value={w.updatedAt} dateOnly />
                    </TableCell>
                    <TableCell>
                      <RowMenu
                        label={w.name}
                        onRename={() => setAction({ kind: "rename", type: "workbook", id: w.id, name: w.name })}
                        onMove={() => setAction({ kind: "move", type: "workbook", id: w.id, name: w.name, current: w.folderId })}
                        onDelete={() => setAction({ kind: "delete", type: "workbook", id: w.id, name: w.name })}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ))}

        {fromFile && (
          <ImportWizard
            tableId={fromFile.tableId}
            initialFile={fromFile.file}
            onImported={async () => {
              fromFileImported.current = true;
            }}
            onClose={() => void finishFromFile()}
          />
        )}
        {action?.kind === "newFolder" && (
          <NameDialog
            title="New folder"
            submitLabel="Create folder"
            onSubmit={(name) => mutate(gridRequest(gridUrl.folders, "POST", { name: name || undefined, parentId: folderId ?? null }))}
            onClose={() => setAction(null)}
          />
        )}
        {action?.kind === "newWorkbook" && <NameDialog title="New workbook" description="A workbook holds one or more tables." submitLabel="Create workbook" onSubmit={createWorkbook} onClose={() => setAction(null)} />}
        {action?.kind === "rename" && (
          <NameDialog
            title={`Rename ${action.type}`}
            initial={action.name}
            submitLabel="Rename"
            onSubmit={(name) => mutate(gridRequest(`${action.type === "folder" ? gridUrl.folders : gridUrl.workbooks}/${action.id}`, "PATCH", { name }))}
            onClose={() => setAction(null)}
          />
        )}
        {action?.kind === "move" && (
          <MoveDialog
            action={action}
            folders={allFolders}
            onSubmit={(dest) => mutate(gridRequest(`${action.type === "folder" ? gridUrl.folders : gridUrl.workbooks}/${action.id}`, "PATCH", action.type === "folder" ? { parentId: dest } : { folderId: dest }))}
            onClose={() => setAction(null)}
          />
        )}
        {action?.kind === "delete" && (
          <ConfirmDialog
            open
            onOpenChange={(open) => !open && setAction(null)}
            title={`Delete ${action.type} "${action.name}"?`}
            description={action.type === "folder" ? "Subfolders are deleted. Workbooks inside move to the top level." : "Its tables, rows and run history are deleted. This cannot be undone."}
            confirmLabel={`Delete ${action.type}`}
            pendingLabel="Deleting..."
            destructive
            onConfirm={async () => {
              const problem = await mutate(gridRequest(`${action.type === "folder" ? gridUrl.folders : gridUrl.workbooks}/${action.id}`, "DELETE"));
              if (problem) throw new Error(problem);
              toast.success(`Deleted "${action.name}".`);
            }}
          />
        )}
      </div>
    </>
  );
}

function RowMenu({ label, onRename, onMove, onDelete }: { label: string; onRename: () => void; onMove: () => void; onDelete: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${label}`} className="relative z-10" />}>
        <MoreHorizontalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuItem onClick={onRename}>Rename</DropdownMenuItem>
        <DropdownMenuItem onClick={onMove}>Move</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onDelete}>
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A folder's descendants cannot receive it, so they are left out of the list. */
function descendants(folders: FolderNode[], id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (f.parentId && out.has(f.parentId) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
    }
  }
  return out;
}

function pathLabel(folders: FolderNode[], id: string): string {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const parts: string[] = [];
  for (let cur = byId.get(id), n = 0; cur && n < 20; cur = cur.parentId ? byId.get(cur.parentId) : undefined, n++) parts.unshift(cur.name);
  return parts.join(" / ");
}

function MoveDialog({ action, folders, onSubmit, onClose }: { action: Extract<Action, { kind: "move" }>; folders: FolderNode[]; onSubmit: (destination: string | null) => Promise<string | null>; onClose: () => void }) {
  const [dest, setDest] = useState(action.current ?? ROOT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = action.type === "folder" ? descendants(folders, action.id) : new Set<string>();
  const items = [{ value: ROOT, label: "Top level" }, ...folders.filter((f) => !blocked.has(f.id)).map((f) => ({ value: f.id, label: pathLabel(folders, f.id) })).sort((a, b) => a.label.localeCompare(b.label))];
  async function submit() {
    setBusy(true);
    const problem = await onSubmit(dest === ROOT ? null : dest);
    setBusy(false);
    if (problem) return setError(problem);
    onClose();
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move &ldquo;{action.name}&rdquo;</DialogTitle>
          <DialogDescription>Choose where it should live.</DialogDescription>
        </DialogHeader>
        <Field label="Destination" htmlFor="move-dest">
          <Choice id="move-dest" items={items} value={dest} onChange={setDest} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? "Moving..." : "Move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
