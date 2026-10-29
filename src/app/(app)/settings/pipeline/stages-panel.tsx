"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { StageSetting, StageSettings } from "@/contexts/deals/application/deal-stages";
import { orThrow, runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { useApiAction } from "@/app/_lib/use-api-action";
import { AdminNotice } from "../admin-notice";
import { ReorderButtons } from "../settings-form";
import { RULED_LIST, SettingsSection } from "../settings-section";
import { moveTarget, stageBlocker } from "./stage-rules";
import { countOf } from "@/shared/format-number";
import { Count } from "@/components/shell/section";

const KIND_ITEMS = [
  { value: "open", label: "Open" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
];

const KIND_LABEL: Record<string, string> = { won: "Won", lost: "Lost" };

/** Settings > Pipeline stages: rename, move up and down, add and delete. Every write answers with the new list. */
export function StagesPanel({ settings: initial, canManage }: { settings: StageSettings; canManage: boolean }) {
  const router = useRouter();
  const [settings, setSettings] = useState(initial);
  const [seen, setSeen] = useState(initial);
  // Each answer is the whole list and an order write sends every id, so all stage changes share one key.
  const { isBusy, run } = useApiAction<"list">();
  const pending = isBusy("list");
  const refresh = () => router.refresh();
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<StageSetting | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("open");

  if (initial !== seen) {
    setSeen(initial);
    setSettings(initial);
  }

  const stages = settings.stages;

  /** Sends one change; the answer is the new list. A refusal shows in the line under the list. True when it went through. */
  const write = (url: string, method: "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown, done?: string) =>
    run("list", async () => {
      setError(null);
      const result = await runApiAction(callApi<StageSettings>(url, method, body), { refresh, expectData: true });
      if (!result.ok) {
        setError(result.error);
        return false;
      }
      setSettings(result.data);
      if (done) toast.success(done);
      return true;
    });

  function move(index: number, direction: -1 | 1) {
    const other = moveTarget(stages, index, direction);
    if (other === null) return;
    const ids = stages.map((s) => s.id as string);
    [ids[index], ids[other]] = [ids[other], ids[index]];
    void write("/api/deal-stages/order", "PUT", { ids });
  }

  async function rename(event: FormEvent) {
    event.preventDefault();
    if (!renaming || renaming.name.trim() === "") return;
    if (await write(`/api/deal-stages/${renaming.id}`, "PATCH", { name: renaming.name.trim() }, "Stage renamed.")) setRenaming(null);
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === "") return;
    if (await write("/api/deal-stages", "POST", { name: name.trim(), kind }, `Added ${name.trim()}.`)) setName("");
  }

  function askDelete(stage: StageSetting) {
    const blocker = stageBlocker(stages, stage);
    if (blocker) return setError(blocker);
    setError(null);
    setDeleting(stage);
  }

  async function remove(): Promise<boolean> {
    const stage = deleting;
    if (!stage?.id) return true;
    const ran = await run("list", async () => {
      setSettings(orThrow(await runApiAction(callApi<StageSettings>(`/api/deal-stages/${stage.id}`, "DELETE"), { refresh, expectData: true })));
      toast.success(`Deleted ${stage.name}.`);
      return true;
    });
    if (ran === null) throw new Error("Another change to the stages is still saving. Try again in a moment.");
    return true;
  }

  return (
    <>
      {!canManage && (
        <div className="pb-section">
          <AdminNotice action="change the stages" />
        </div>
      )}
      <SettingsSection
        title="Stages"
        description={
          settings.virtual
            ? "Your pipeline uses these default stages. Create them to rename, reorder or delete them."
            : "Deals move through these stages in this order. Won and Lost come last. A stage never stops outreach."
        }
      >
        {canManage && settings.virtual && (
          <div>
            <Button size="sm" disabled={pending} onClick={() => void write("/api/deal-stages/defaults", "POST", undefined, "Default stages created.")}>
              {pending ? "Creating…" : "Create default stages"}
            </Button>
          </div>
        )}
        {/* The stages are the ruled list itself: a hairline between rows, no box around them. */}
        <ol className={`grid ${RULED_LIST}`} aria-label="Stages">
          {stages.map((stage, index) => {
            const editing = renaming !== null && renaming.id === stage.id;
            return (
              <li key={stage.id ?? stage.name} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 py-2 text-sm">
                {editing ? (
                  <form onSubmit={rename} className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    <Input
                      aria-label={`New name for ${stage.name}`}
                      value={renaming.name}
                      onChange={(e) => setRenaming({ id: renaming.id, name: e.target.value })}
                      onKeyDown={(e) => e.key === "Escape" && setRenaming(null)}
                      maxLength={60}
                      className="max-w-56 min-w-0 flex-1"
                      autoFocus
                    />
                    <Button type="submit" size="sm" disabled={pending || renaming.name.trim() === "" || renaming.name.trim() === stage.name}>
                      Save
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setRenaming(null)}>
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <div className="flex min-w-32 flex-1 items-center gap-2">
                    <span className="truncate font-medium">{stage.name}</span>
                    {KIND_LABEL[stage.kind] && <Badge variant="outline">{KIND_LABEL[stage.kind]}</Badge>}
                  </div>
                )}
                <Count value={countOf(stage.dealCount, "deal")} />
                {canManage && !settings.virtual && !editing && (
                  <div className="flex items-center gap-1">
                    <ReorderButtons name={stage.name} canUp={moveTarget(stages, index, -1) !== null} canDown={moveTarget(stages, index, 1) !== null} disabled={pending} onMove={(direction) => move(index, direction)} />
                    <Button variant="ghost" size="sm" disabled={pending} onClick={() => setRenaming({ id: stage.id as string, name: stage.name })} aria-label={`Rename ${stage.name}`}>
                      Rename
                    </Button>
                    <Button variant="ghost" size="sm" disabled={pending} onClick={() => askDelete(stage)} aria-label={`Delete ${stage.name}`}>
                      Delete
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </SettingsSection>

      {canManage && (
        <SettingsSection title="Add a stage" description="A new stage goes after the last stage of its kind.">
          <form onSubmit={add} className="flex flex-wrap items-end gap-group">
            <Field className="min-w-0 flex-1 basis-48">
              <FieldLabel htmlFor="new-stage-name">Name</FieldLabel>
              <Input id="new-stage-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Negotiation" />
            </Field>
            <Field className="w-auto">
              <FieldLabel htmlFor="new-stage-kind">Kind</FieldLabel>
              <Select items={KIND_ITEMS} value={kind} onValueChange={(v) => v && setKind(v)}>
                <SelectTrigger id="new-stage-kind" className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KIND_ITEMS.map((k) => (
                    <SelectItem key={k.value} value={k.value}>
                      {k.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Button type="submit" disabled={pending || name.trim() === ""}>
              Add stage
            </Button>
          </form>
        </SettingsSection>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "stage"}?`}
        description="The stage leaves the pipeline. It has no deals, so nothing else changes."
        confirmLabel="Delete stage"
        cancelLabel="Keep stage"
        pendingLabel="Deleting…"
        confirmDisabled={pending}
        destructive
        onConfirm={remove}
      />
    </>
  );
}
