"use client";

import { useState } from "react";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { ItemSelect } from "./form-bits";

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
  const blocked = action.type === "folder" ? descendants(folders, action.id) : new Set<string>();
  const items = [{ value: ROOT, label: "Top level" }, ...folders.filter((f) => !blocked.has(f.id)).map((f) => ({ value: f.id, label: pathLabel(folders, f.id) })).sort((a, b) => a.label.localeCompare(b.label))];
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Move “${action.name}”`}
      description="Choose where it should live."
      confirmLabel="Move"
      pendingLabel="Moving…"
      onConfirm={async () => {
        const problem = await onSubmit(dest === ROOT ? null : dest);
        if (problem) throw new Error(problem);
      }}
    >
      <Field>
        <FieldLabel htmlFor="move-dest">Destination</FieldLabel>
        <ItemSelect id="move-dest" items={items} value={dest} onChange={setDest} />
      </Field>
    </ConfirmDialog>
  );
}
