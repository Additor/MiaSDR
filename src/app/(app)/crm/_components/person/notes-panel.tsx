"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Time } from "@/components/shell/time";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { callApi } from "@/lib/api-client";

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
  /** False inside a page section that already names it, such as the Activity tabs. */
  heading?: boolean;
};

export function NotesPanel({ notes, currentUserId, isAdmin, heading = true, ...target }: NotesPanelProps) {
  const router = useRouter();
  const base = target.recordId !== undefined ? `/api/crm/records/${target.recordId}/notes` : `/api/people/${target.personId}/notes`;
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState<{ id: string; title: string; body: string } | null>(null);
  // The target stays set while the dialog closes, so its title does not change mid-animation.
  const [deleting, setDeleting] = useState<Note | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (body.trim() === "") return setError("Write the note first.");
    setPending(true);
    setError(null);
    const result = await callApi(base, "POST", { title: null, body });
    setPending(false);
    if (!result.ok) return setError(result.error);
    setBody("");
    toast.success("Note added.");
    router.refresh();
  }

  async function remove(id: string) {
    const result = await callApi(`${base}/${id}`, "DELETE");
    if (!result.ok) throw new Error(result.error ?? "Could not delete the note. Try again.");
    toast.success("Note deleted.");
    router.refresh();
  }

  async function save() {
    if (!editing) return;
    const result = await callApi(`${base}/${editing.id}`, "PATCH", { title: editing.title.trim() || null, body: editing.body });
    if (!result.ok) return setError(result.error);
    setError(null);
    setEditing(null);
    toast.success("Note saved.");
    router.refresh();
  }

  const content = (
    <div className="stack-group">
      <form onSubmit={add} className="grid gap-2" noValidate>
        <Label htmlFor="note-body" className="sr-only">
          Note
        </Label>
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
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div>
          <Button type="submit" size="sm" variant="outline" disabled={pending} className="max-sm:h-11">
            Add note
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
                    <Button type="button" size="sm" onClick={save} disabled={editing.body.trim() === ""} className="max-sm:h-11">
                      Save
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)} className="max-sm:h-11">
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
      {heading ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Notes</CardTitle>
            <CardDescription>Private to your organization. Notes follow the person, not the thread.</CardDescription>
          </CardHeader>
          <CardContent>{content}</CardContent>
        </Card>
      ) : (
        content
      )}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete the note "${deleting?.title ?? "Note"}"?`}
        description="The note is removed for everyone in your organization. This cannot be undone."
        confirmLabel="Delete note"
        pendingLabel="Deleting…"
        destructive
        onConfirm={() => deleting && remove(deleting.id)}
      />
    </>
  );
}
