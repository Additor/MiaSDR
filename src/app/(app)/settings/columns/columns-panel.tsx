"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { callApi } from "@/app/_lib/api-client";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { EmptyState } from "@/components/shell/empty-state";
import { Tabs } from "@/components/shell/tabs";
import { cn } from "@/components/ui/utils";
import { ReorderButtons } from "../settings-form";
import { RULED_LIST, RULED_ROW, SettingsSection } from "../settings-section";

type Entity = "people" | "companies";

interface Column {
  id: string;
  key: string;
  name: string;
  archivedAt: string | null;
  usedBy: number;
}

const TITLES: Record<Entity, string> = { people: "Person fields", companies: "Company fields" };
/** Where the fields of each type show, in the order set here. */
const SHOWN_ON: Record<Entity, string> = { people: "the lead and contact forms", companies: "the company form" };

export function ColumnsPanel({ canManage, initial }: { canManage: boolean; initial: Record<Entity, Column[]> }) {
  return (
    <div className="max-w-3xl">
      <Tabs
        label="Field type"
        tabs={(Object.keys(TITLES) as Entity[]).map((entity) => ({
          id: entity,
          label: TITLES[entity],
          content: <EntityColumns entity={entity} columns={initial[entity]} canManage={canManage} />,
        }))}
      />
    </div>
  );
}

function EntityColumns({ entity, columns, canManage }: { entity: Entity; columns: Column[]; canManage: boolean }) {
  const router = useRouter();
  const nameId = useId();
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Column | null>(null);
  const [archiving, setArchiving] = useState<Column | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const active = columns.filter((c) => !c.archivedAt);
  const archived = columns.filter((c) => c.archivedAt);

  async function run(call: Promise<{ ok: boolean; error: string | null }>, done?: string) {
    setPending(true);
    const result = await call;
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    setError(null);
    if (done) toast.success(done);
    router.refresh();
    return true;
  }

  /** For a ConfirmDialog: a failure throws, so the dialog stays open and shows the message. */
  async function runOrThrow(call: Promise<{ ok: boolean; error: string | null }>, done: string) {
    const result = await call;
    if (!result.ok) throw new Error(result.error ?? "Something went wrong. Try again.");
    setError(null);
    toast.success(done);
    router.refresh();
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (await run(callApi("/api/leads/columns", "POST", { entity, name }), "Field added.")) setName("");
  }

  async function rename(event: React.FormEvent, id: string) {
    event.preventDefault();
    if (draft.trim() === "") return;
    if (await run(callApi(`/api/leads/columns/${id}`, "PATCH", { name: draft.trim() }), "Field renamed.")) setEditingId(null);
  }

  function move(index: number, delta: number) {
    const ids = active.map((c) => c.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    void run(callApi("/api/leads/columns", "PUT", { entity, ids }));
  }

  return (
    <div>
      <SettingsSection title={TITLES[entity]} description={active.length > 0 ? `Order here is the order on ${SHOWN_ON[entity]}.` : undefined}>
        {active.length === 0 ? (
          <EmptyState
            className="py-0"
            title={`No ${entity === "people" ? "person" : "company"} fields yet`}
            description={canManage ? "Add one below, or import a file with extra columns and MiaSDR creates them for you." : "An owner or admin can add one, or an import can create them."}
            action={{ label: "Import leads", href: "/leads/import" }}
          />
        ) : (
          <ul className={RULED_LIST}>
            {active.map((column, index) => (
              <li key={column.id} className={cn(RULED_ROW, "flex min-h-11 flex-wrap items-center gap-2")}>
                {editingId === column.id ? (
                  <form onSubmit={(e) => rename(e, column.id)} className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    <Input
                      aria-label={`New name for ${column.name}`}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => e.key === "Escape" && setEditingId(null)}
                      maxLength={60}
                      className="max-w-56 min-w-0 flex-1"
                      autoFocus
                    />
                    <Button type="submit" size="sm" disabled={pending || draft.trim() === "" || draft.trim() === column.name}>
                      Save
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <>
                    <span className="font-medium">{column.name}</span>
                    <span className="text-sm text-muted-foreground">{column.usedBy} with a value</span>
                    {canManage && (
                      <span className="ml-auto flex items-center gap-1">
                        <ReorderButtons name={column.name} canUp={index > 0} canDown={index < active.length - 1} disabled={pending} onMove={(direction) => move(index, direction)} />
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditingId(column.id);
                            setDraft(column.name);
                          }}
                        >
                          Rename
                        </Button>
                        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setArchiving(column)}>
                          Archive
                        </Button>
                      </span>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </SettingsSection>
      {canManage && (
        <SettingsSection title="Add a field" description="Imports turn extra file columns into fields too. Names are unique per type, ignoring case.">
          <form onSubmit={add} className="flex flex-wrap items-end gap-group">
            <Field className="w-auto">
              <FieldLabel htmlFor={nameId}>Name</FieldLabel>
              <Input id={nameId} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required className="w-64 max-w-full" />
            </Field>
            <Button type="submit" disabled={pending || name.trim() === ""}>
              Add field
            </Button>
          </form>
        </SettingsSection>
      )}
      {archived.length > 0 && (
        <SettingsSection title={`Archived (${archived.length})`} description="Archived fields keep their values. Delete one to remove the values from every row.">
          <ul className={RULED_LIST}>
            {archived.map((column) => (
              <li key={column.id} className={cn(RULED_ROW, "flex min-h-11 flex-wrap items-center gap-2")}>
                <span className="font-medium">{column.name}</span>
                <span className="text-sm text-muted-foreground">{column.usedBy} with a value</span>
                {canManage && (
                  <span className="ml-auto flex gap-1">
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(callApi(`/api/leads/columns/${column.id}`, "PATCH", { archived: false }), `${column.name} restored.`)}>
                      Restore
                    </Button>
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => setDeleting(column)}>
                      Delete
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </SettingsSection>
      )}
      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => !open && setArchiving(null)}
        title={`Archive "${archiving?.name ?? "this field"}"?`}
        description={`It leaves ${SHOWN_ON[entity]}. Its values stay on ${archiving?.usedBy ?? 0} ${entity === "people" ? "people" : "companies"}, and you can restore it later.`}
        confirmLabel="Archive field"
        pendingLabel="Archiving…"
        onConfirm={() => archiving && runOrThrow(callApi(`/api/leads/columns/${archiving.id}`, "PATCH", { archived: true }), `${archiving.name} archived.`)}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete "${deleting?.name ?? "this field"}"?`}
        description={`Its value is removed from ${deleting?.usedBy ?? 0} ${entity === "people" ? "people" : "companies"}. This cannot be undone.`}
        confirmLabel="Delete field"
        cancelLabel="Keep field"
        pendingLabel="Deleting…"
        destructive
        onConfirm={() => deleting && runOrThrow(callApi(`/api/leads/columns/${deleting.id}`, "DELETE"), `${deleting.name} deleted.`)}
      />
    </div>
  );
}
