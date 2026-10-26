"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { REPLY_CATEGORIES } from "@/contexts/conversations/domain/reply-handling";
import { callApi } from "@/app/_lib/api-client";
import { cn } from "@/components/ui/utils";
import { RULED_LIST, RULED_ROW, SettingsSection } from "../settings-section";

interface Sub {
  id: string;
  categoryKey: string;
  key: string;
  name: string;
  description: string | null;
  classificationGuidance: string | null;
  active: boolean;
  reviewRequired: boolean;
  stageRank: number | null;
  recordCount: number;
  historyCount: number;
}

interface Draft {
  category: string;
  name: string;
  description: string;
  guidance: string;
  rank: string;
  review: boolean;
}

const CATEGORY_ITEMS = REPLY_CATEGORIES.map((c) => ({ value: c.key, label: c.label }));

const archiveRecords = (count: number) => (count === 0 ? "Nobody is in it now." : `${count} ${count === 1 ? "person keeps" : "people keep"} this subcategory.`);

const draftOf = (sub: Sub | null, category = "interested"): Draft => ({
  category: sub?.categoryKey ?? category,
  name: sub?.name ?? "",
  description: sub?.description ?? "",
  guidance: sub?.classificationGuidance ?? "",
  rank: sub?.stageRank?.toString() ?? "",
  review: sub?.reviewRequired ?? false,
});

export function TaxonomyPanel({ subcategories, canManage }: { subcategories: Sub[]; canManage: boolean }) {
  const router = useRouter();
  // `editing` null with the dialog open adds a subcategory.
  const [dialog, setDialog] = useState<{ editing: Sub | null } | null>(null);
  const [draft, setDraft] = useState<Draft>(draftOf(null));
  const [confirming, setConfirming] = useState<{ sub: Sub; action: "archive" | "delete" } | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  function open(sub: Sub | null, category?: string) {
    setDraft(draftOf(sub, category));
    setDialog({ editing: sub });
  }

  async function save() {
    const editing = dialog?.editing ?? null;
    const common = {
      name: draft.name,
      description: draft.description.trim() || null,
      classificationGuidance: draft.guidance.trim() || null,
      reviewRequired: draft.review,
      stageRank: draft.rank.trim() === "" ? null : Number(draft.rank),
    };
    const result = editing ? await callApi(`/api/reply-categories/subcategories/${editing.id}`, "PATCH", common) : await callApi("/api/reply-categories/subcategories", "POST", { ...common, categoryKey: draft.category });
    if (!result.ok) throw new Error(result.error ?? "Could not save the subcategory.");
    toast.success(editing ? `${draft.name} saved.` : `${draft.name} added.`);
    router.refresh();
  }

  /** Archive and restore. A failure throws so the confirmation dialog can show it; Restore has no dialog and reports below the list. */
  async function toggle(sub: Sub) {
    const result = await callApi(`/api/reply-categories/subcategories/${sub.id}`, "PATCH", { active: !sub.active });
    if (!result.ok) throw new Error(result.error ?? "Something went wrong. Try again.");
    toast.success(sub.active ? `${sub.name} archived.` : `${sub.name} restored.`);
    router.refresh();
  }

  async function remove(sub: Sub) {
    const result = await callApi(`/api/reply-categories/subcategories/${sub.id}`, "DELETE");
    if (!result.ok) throw new Error(result.error ?? "Something went wrong. Try again.");
    toast.success(`${sub.name} deleted.`);
    router.refresh();
  }

  function restore(sub: Sub) {
    setRestoreError(null);
    toggle(sub).catch((e: unknown) => setRestoreError(e instanceof Error ? e.message : "Something went wrong. Try again."));
  }

  const editing = dialog?.editing ?? null;
  return (
    <>
      {/* Two levels only: a category is a group with an h3, its subcategories are the rows of one ruled list. */}
      <SettingsSection
        title="Subcategories"
        description="The four reply categories are fixed. Their subcategories are what the AI picks from, and the guidance tells it when to choose one. A position orders the subcategories from first reply to outcome, and the AI never moves a person to a lower position on its own."
        action={
          canManage ? (
            <Button variant="outline" onClick={() => open(null)}>
              Add subcategory
            </Button>
          ) : undefined
        }
      >
        <div className="stack-section">
          {REPLY_CATEGORIES.map((c) => {
            const subs = subcategories.filter((s) => s.categoryKey === c.key);
            return (
              <div key={c.key} className="stack-group" data-testid={`category-${c.key}`}>
                <h3 className="text-sm font-semibold">{c.label}</h3>
                {subs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No subcategories.</p>
                ) : (
                  <ul className={RULED_LIST} aria-label={`${c.label} subcategories`}>
                    {subs.map((s) => (
                      <li key={s.id} className={cn(RULED_ROW, "flex flex-wrap items-start gap-x-3 gap-y-1 text-sm")}>
                        <div className={cn("grid min-w-0 flex-1 gap-1", !s.active && "opacity-60")}>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{s.name}</span>
                            {s.stageRank !== null && <Badge variant="secondary">Position {s.stageRank}</Badge>}
                            {s.reviewRequired && <Badge variant="secondary">Always reviewed</Badge>}
                            {!s.active && <Badge variant="outline">Archived</Badge>}
                            <span className="text-xs text-muted-foreground">
                              {s.recordCount} {s.recordCount === 1 ? "person" : "people"}
                            </span>
                          </div>
                          {s.description && <p className="text-muted-foreground">{s.description}</p>}
                          {s.classificationGuidance && <p className="whitespace-pre-wrap text-muted-foreground">Guidance: {s.classificationGuidance}</p>}
                        </div>
                        {canManage && (
                          <div className="flex shrink-0 gap-1">
                            <Button size="sm" variant="ghost" onClick={() => open(s)} aria-label={`Edit ${s.name}`}>
                              Edit
                            </Button>
                            {s.key !== "do_not_contact" && (
                              <Button size="sm" variant="ghost" onClick={() => (s.active ? setConfirming({ sub: s, action: "archive" }) : restore(s))}>
                                {s.active ? "Archive" : "Restore"}
                              </Button>
                            )}
                            {s.key !== "do_not_contact" && s.recordCount === 0 && s.historyCount === 0 && (
                              <Button size="sm" variant="ghost" onClick={() => setConfirming({ sub: s, action: "delete" })}>
                                Delete
                              </Button>
                            )}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
        {restoreError && (
          <p role="alert" className="text-sm text-destructive">
            {restoreError}
          </p>
        )}
      </SettingsSection>

      <ConfirmDialog
        open={dialog !== null}
        onOpenChange={(next) => !next && setDialog(null)}
        title={editing ? `Edit ${editing.name}` : "Add a subcategory"}
        description="The AI reads the name, the description and the guidance when it classifies a reply."
        confirmLabel={editing ? "Save" : "Add subcategory"}
        pendingLabel="Saving…"
        confirmDisabled={draft.name.trim() === ""}
        className="sm:max-w-lg"
        onConfirm={save}
      >
        <FieldGroup>
          <div className="flex flex-wrap gap-group">
            <Field className="w-auto">
              <FieldLabel htmlFor="sub-category">Category</FieldLabel>
              <Select items={CATEGORY_ITEMS} value={draft.category} onValueChange={(v) => v && setDraft({ ...draft, category: v })} disabled={editing !== null}>
                <SelectTrigger id="sub-category" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORY_ITEMS.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field className="w-auto">
              <FieldLabel htmlFor="sub-rank">Position</FieldLabel>
              <Input id="sub-rank" type="number" min={1} max={100} value={draft.rank} onChange={(e) => setDraft({ ...draft, rank: e.target.value })} placeholder="Outcome" className="w-28" />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="sub-name">Name</FieldLabel>
            <Input id="sub-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required maxLength={100} />
          </Field>
          <Field>
            <FieldLabel htmlFor="sub-description">Description (optional)</FieldLabel>
            <Input id="sub-description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} maxLength={500} />
          </Field>
          <Field>
            <FieldLabel htmlFor="sub-guidance">Guidance for the AI (optional)</FieldLabel>
            <Textarea id="sub-guidance" value={draft.guidance} onChange={(e) => setDraft({ ...draft, guidance: e.target.value })} maxLength={2000} placeholder="Choose this when the sender asks for pricing or a quote." />
            <FieldDescription>When the AI should pick this subcategory over the others.</FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <Checkbox id="sub-review" checked={draft.review} onCheckedChange={(c) => setDraft({ ...draft, review: c === true })} />
            <FieldLabel htmlFor="sub-review">A person confirms every AI choice of this subcategory</FieldLabel>
          </Field>
        </FieldGroup>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={confirming ? `${confirming.action === "archive" ? "Archive" : "Delete"} ${confirming.sub.name}?` : "Archive subcategory?"}
        description={
          confirming?.action === "delete"
            ? "Nobody is in it and no classification history names it. Deleting removes it for good."
            : `${archiveRecords(confirming?.sub.recordCount ?? 0)} The AI stops choosing it for new replies. Restore it any time.`
        }
        confirmLabel={confirming?.action === "delete" ? "Delete subcategory" : "Archive subcategory"}
        destructive={confirming?.action === "delete"}
        onConfirm={() => confirming && (confirming.action === "delete" ? remove(confirming.sub) : toggle(confirming.sub))}
      />
    </>
  );
}
