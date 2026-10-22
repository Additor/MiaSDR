"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { REPLY_CATEGORIES } from "@/contexts/conversations/domain/reply-handling";
import { callApi } from "@/lib/api-client";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { cn } from "@/lib/utils";
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

const CATEGORY_ITEMS = REPLY_CATEGORIES.map((c) => ({ value: c.key, label: c.label }));

const archiveRecords = (count: number) => (count === 0 ? "Nobody is in it now." : `${count} ${count === 1 ? "person keeps" : "people keep"} this subcategory.`);

export function TaxonomyPanel({ subcategories }: { subcategories: Sub[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<Sub | null>(null);
  const [confirming, setConfirming] = useState<{ sub: Sub; action: "archive" | "delete" } | null>(null);
  const [category, setCategory] = useState<string>("interested");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [guidance, setGuidance] = useState("");
  const [rank, setRank] = useState("");
  const [review, setReview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function edit(sub: Sub | null) {
    setEditing(sub);
    setCategory(sub?.categoryKey ?? "interested");
    setName(sub?.name ?? "");
    setDescription(sub?.description ?? "");
    setGuidance(sub?.classificationGuidance ?? "");
    setRank(sub?.stageRank?.toString() ?? "");
    setReview(sub?.reviewRequired ?? false);
    setError(null);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const common = { name, description: description.trim() || null, classificationGuidance: guidance.trim() || null, reviewRequired: review, stageRank: rank.trim() === "" ? null : Number(rank) };
    const result = editing ? await callApi(`/api/reply-categories/subcategories/${editing.id}`, "PATCH", common) : await callApi("/api/reply-categories/subcategories", "POST", { ...common, categoryKey: category });
    setPending(false);
    if (!result.ok) return setError(result.error);
    toast.success(editing ? "Subcategory saved." : "Subcategory added.");
    edit(null);
    router.refresh();
  }

  /** Archive and restore. A failure throws so the confirmation dialog can show it; Restore has no dialog and reports through setError. */
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
    setError(null);
    toggle(sub).catch((e: unknown) => setError(e instanceof Error ? e.message : "Something went wrong. Try again."));
  }

  return (
    <>
      <SettingsSection
        title={editing ? `Edit ${editing.name}` : "Add a subcategory"}
        description="The four reply categories are fixed. Their subcategories are what the AI picks from, and the guidance tells it when to choose one. A position orders the subcategories from first reply to outcome, and the AI never moves a person to a lower position on its own."
      >
        <form onSubmit={save} className="stack-group">
          <div className="flex flex-wrap gap-3">
            <div className="stack-field">
              <Label htmlFor="sub-category">Category</Label>
              <Select items={CATEGORY_ITEMS} value={category} onValueChange={(v) => v && setCategory(v)} disabled={editing !== null}>
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
            </div>
            <div className="stack-field">
              <Label htmlFor="sub-name">Name</Label>
              <Input id="sub-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} className="w-64 max-w-full" />
            </div>
            <div className="stack-field">
              <Label htmlFor="sub-rank">Position</Label>
              <Input id="sub-rank" type="number" min={1} max={100} value={rank} onChange={(e) => setRank(e.target.value)} placeholder="Outcome" className="w-28" />
            </div>
          </div>
          <div className="stack-field">
            <Label htmlFor="sub-description">Description (optional)</Label>
            <Input id="sub-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
          </div>
          <div className="stack-field">
            <Label htmlFor="sub-guidance">Guidance for the AI (optional)</Label>
            <Textarea id="sub-guidance" value={guidance} onChange={(e) => setGuidance(e.target.value)} maxLength={2000} placeholder="Choose this when the sender asks for pricing or a quote." />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="sub-review" checked={review} onCheckedChange={(c) => setReview(c === true)} />
            <Label htmlFor="sub-review">A person confirms every AI choice of this subcategory</Label>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Saving…" : editing ? "Save changes" : "Add subcategory"}
            </Button>
            {editing && (
              <Button type="button" size="sm" variant="ghost" onClick={() => edit(null)}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      </SettingsSection>

      {/* Two levels only: a category is a group with an h3, its subcategories are the rows of one ruled list. */}
      <SettingsSection title="Subcategories">
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
                      <li key={s.id} className={cn(RULED_ROW, "grid gap-1 text-sm", !s.active && "opacity-60")}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{s.name}</span>
                          {s.stageRank !== null && <Badge variant="secondary">Position {s.stageRank}</Badge>}
                          {s.reviewRequired && <Badge variant="secondary">Always reviewed</Badge>}
                          {!s.active && <Badge variant="outline">Archived</Badge>}
                          <span className="text-xs text-muted-foreground">{s.recordCount} {s.recordCount === 1 ? "person" : "people"}</span>
                        </div>
                        {s.description && <p className="text-muted-foreground">{s.description}</p>}
                        {s.classificationGuidance && <p className="whitespace-pre-wrap text-muted-foreground">Guidance: {s.classificationGuidance}</p>}
                        <div className="flex flex-wrap gap-2 pt-1">
                          <Button size="xs" variant="outline" onClick={() => edit(s)}>
                            Edit
                          </Button>
                          {s.key !== "do_not_contact" && (
                            <Button size="xs" variant="ghost" onClick={() => (s.active ? setConfirming({ sub: s, action: "archive" }) : restore(s))}>
                              {s.active ? "Archive" : "Restore"}
                            </Button>
                          )}
                          {s.key !== "do_not_contact" && s.recordCount === 0 && s.historyCount === 0 && (
                            <Button size="xs" variant="ghost" onClick={() => setConfirming({ sub: s, action: "delete" })}>
                              Delete
                            </Button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </SettingsSection>
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
