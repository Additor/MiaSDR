"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Choice, ErrorText, Field } from "./form-bits";

export interface FolderNode {
  id: string;
  name: string;
  parentId: string | null;
}

/** What moves: a folder or a workbook, and the folder it sits in now (null at the top level). */
export interface MoveTarget {
  type: "folder" | "workbook";
  id: string;
  name: string;
  current: string | null;
}

const ROOT = "__root__";

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

/** Moves a folder or a workbook to another folder or the top level. A folder cannot move into itself or below itself. */
export function MoveDialog({ action, folders, onSubmit, onClose }: { action: MoveTarget; folders: FolderNode[]; onSubmit: (destination: string | null) => Promise<string | null>; onClose: () => void }) {
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
