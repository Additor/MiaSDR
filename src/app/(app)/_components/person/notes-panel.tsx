"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Time } from "@/components/shell/time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldError, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { toastOrThrow, useApiAction } from "@/app/_lib/use-api-action";

export interface Note {
  id: string;
  title: string | null;
  body: string;
  createdAt: string;
  authorName: string | null;
  createdBy: string | null;
}

/** Where the panel writes: a reply record's notes, or a person's notes (every note of the person; new ones have no record). */
export type NoteTarget = { recordId: string; personId?: never } | { personId: string; recordId?: never };

export type NotesPanelProps = NoteTarget & {
  notes: Note[];
  currentUserId: string;
  isAdmin: boolean;
};

export function NotesPanel({ notes, currentUserId, isAdmin, ...target }: NotesPanelProps) {
  const router = useRouter();
  const base = target.recordId !== undefined ? `/api/records/${target.recordId}/notes` : `/api/people/${target.personId}/notes`;
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { isBusy, run } = useApiAction<"add" | "save">();
  const refresh = () => router.refresh();
  const [editing, setEditing] = useState<{ id: string; title: string; body: string } | null>(null);
  // The target stays set while the dialog closes, so its title does not change mid-animation.
  const [deleting, setDeleting] = useState<Note | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  function add(event: React.FormEvent) {
    event.preventDefault();
    if (body.trim() === "") return setError("Write the note first.");
    void run("add", async () => {
      setError(null);
      const result = await runApiAction(callApi(base, "POST", { title: null, body }), { refresh });
      if (!result.ok) return setError(result.error);
      setBody("");
      toast.success("Note added.");
    });
  }

  async function remove(id: string) {
    toastOrThrow(await runApiAction(callApi(`${base}/${id}`, "DELETE"), { refresh }), "Note deleted.");
  }

  function save() {
    if (!editing) return;
    void run("save", async () => {
      const result = await runApiAction(callApi(`${base}/${editing.id}`, "PATCH", { title: editing.title.trim() || null, body: editing.body }), { refresh });
      if (!result.ok) return setError(result.error);
      setError(null);
      setEditing(null);
      toast.success("Note saved.");
    });
  }

  const content = (
    <div className="stack-group">
      <form onSubmit={add} className="grid gap-group" noValidate>
        <FieldLabel htmlFor="note-body" className="sr-only">
          Note
        </FieldLabel>
        <Textarea
          id="note-body"
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            if (error) setError(null);
          }}
          maxLength={10_000}
          placeholder="Write a note. Wants a demo with their CTO after the 20th."
          className="min-h-20"
        />
        <FieldError>{error}</FieldError>
        <div>
          <Button type="submit" size="sm" variant="outline" disabled={isBusy("add")} touch>
            {isBusy("add") ? "Adding…" : "Add note"}
          </Button>
        </div>
      </form>
      {notes.length > 0 && (
        <ul className="divide-y border-t" aria-label="Notes">
          {notes.map((n) => {
            const mine = isAdmin || n.createdBy === currentUserId;
            if (editing?.id === n.id) {
              return (
                <li key={n.id} className="grid gap-2 py-3 text-sm">
                  <Input aria-label="Note title" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} maxLength={200} placeholder="Title (optional)" />
                  <Textarea aria-label="Note text" value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} maxLength={10_000} />
                  <div className="flex gap-2">
                    <Button type="button" size="sm" onClick={save} disabled={isBusy("save") || editing.body.trim() === ""} touch>
                      {isBusy("save") ? "Saving…" : "Save"}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)} touch>
                      Cancel
                    </Button>
                  </div>
                </li>
              );
            }
            return (
              <li key={n.id} className="grid gap-1 py-3 text-sm" data-note={n.id}>
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    {n.authorName ?? "Someone"}, <Time value={n.createdAt} />
                  </p>
                  {mine && (
                    <div className="flex gap-1">
                      <Button type="button" size="xs" variant="ghost" onClick={() => setEditing({ id: n.id, title: n.title ?? "", body: n.body })}>
                        Edit
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() => {
                          setDeleting(n);
                          setDeleteOpen(true);
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  )}
                </div>
                {n.title && <p className="font-medium">{n.title}</p>}
                <p className="whitespace-pre-wrap">{n.body}</p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  return (
    <>
      {content}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete the note "${deleting?.title ?? "Note"}"?`}
        description="The note is removed for everyone in your organization. This cannot be undone."
        confirmLabel="Delete note"
        cancelLabel="Keep note"
        pendingLabel="Deleting…"
        destructive
        onConfirm={() => deleting && remove(deleting.id)}
      />
    </>
  );
}
