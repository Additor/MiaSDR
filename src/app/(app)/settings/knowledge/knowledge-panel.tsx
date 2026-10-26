"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { EmptyState } from "@/components/shell/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { callApi } from "@/app/_lib/api-client";
import { splitTagInput } from "@/contexts/conversations/ai/domain/knowledge";
import { cn } from "@/components/ui/utils";
import { AdminNotice } from "../admin-notice";
import { RULED_LIST, RULED_ROW, SettingsSection } from "../settings-section";

interface Doc {
  id: string;
  title: string;
  kind: string;
  alwaysInclude: boolean;
  tags: string[];
  active: boolean;
  version: number;
  content: string;
}

const KIND_LABELS: Record<string, string> = {
  company: "Company",
  product: "Product",
  pricing: "Pricing",
  faq: "FAQ",
  case_study: "Case study",
  objection: "Objection",
  scheduling: "Scheduling",
  custom: "Custom",
};
const kindLabel = (kind: string) => KIND_LABELS[kind] ?? kind.replace(/_/g, " ");
const KINDS = Object.keys(KIND_LABELS).map((k) => ({ value: k, label: kindLabel(k) }));

interface Draft {
  title: string;
  kind: string;
  content: string;
  always: boolean;
  tags: string;
}

const draftOf = (doc: Doc | null): Draft => ({ title: doc?.title ?? "", kind: doc?.kind ?? "custom", content: doc?.content ?? "", always: doc?.alwaysInclude ?? false, tags: (doc?.tags ?? []).join(", ") });

export function KnowledgePanel({ docs, canManage }: { docs: Doc[]; canManage: boolean }) {
  const router = useRouter();
  // `editing` null with the dialog open adds a document.
  const [dialog, setDialog] = useState<{ editing: Doc | null } | null>(null);
  const [draft, setDraft] = useState<Draft>(draftOf(null));
  const [toggleError, setToggleError] = useState<string | null>(null);

  function open(doc: Doc | null) {
    setDraft(draftOf(doc));
    setDialog({ editing: doc });
  }

  async function save() {
    const editing = dialog?.editing ?? null;
    const body = { title: draft.title, kind: draft.kind, content: draft.content, alwaysInclude: draft.always, tags: splitTagInput(draft.tags) };
    const result = editing ? await callApi(`/api/knowledge/${editing.id}`, "PATCH", body) : await callApi("/api/knowledge", "POST", body);
    if (!result.ok) throw new Error(result.error ?? "Could not save the document.");
    toast.success(editing ? `${draft.title} saved.` : `${draft.title} added.`);
    router.refresh();
  }

  async function toggle(doc: Doc) {
    setToggleError(null);
    const result = await callApi(`/api/knowledge/${doc.id}`, "PATCH", { active: !doc.active });
    if (!result.ok) return setToggleError(result.error);
    toast.success(doc.active ? `${doc.title} archived.` : `${doc.title} restored.`);
    router.refresh();
  }

  const editing = dialog?.editing ?? null;
  return (
    <div>
      {!canManage && (
        <div className="pb-section">
          <AdminNotice action="add or change knowledge documents" />
        </div>
      )}
      <SettingsSection
        title="Documents"
        description="Pasted text the AI draws on when it writes replies. Each change to the text keeps the earlier version, so past drafts still cite what the AI saw."
        action={
          canManage && docs.length > 0 ? (
            <Button variant="outline" onClick={() => open(null)}>
              Add document
            </Button>
          ) : undefined
        }
      >
        {docs.length === 0 ? (
          <EmptyState
            className="py-0"
            title="No documents yet"
            description={canManage ? "Paste your pricing, an FAQ or a case study, and the AI can quote it in drafts." : "An owner or admin can add pricing, an FAQ or a case study for the AI to quote."}
            action={canManage ? <Button variant="outline" onClick={() => open(null)}>Add document</Button> : undefined}
          />
        ) : (
          <ul className={RULED_LIST}>
            {docs.map((doc) => (
              <li key={doc.id} data-testid="knowledge-doc" className={cn(RULED_ROW, "flex flex-wrap items-start gap-x-3 gap-y-2")}>
                <div className="stack-field min-w-0 flex-1">
                  <h3 className="text-sm font-medium">{doc.title}</h3>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="secondary">{kindLabel(doc.kind)}</Badge>
                    {doc.alwaysInclude && <Badge variant="outline">Always included</Badge>}
                    {!doc.active && <Badge variant="outline">Archived</Badge>}
                    {doc.tags.map((tag) => (
                      <Badge key={tag} variant="outline">
                        {tag}
                      </Badge>
                    ))}
                    <Badge variant="outline">v{doc.version}</Badge>
                  </div>
                  <p className="line-clamp-2 text-sm whitespace-pre-wrap text-muted-foreground">{doc.content}</p>
                </div>
                {canManage && (
                  <div className="flex shrink-0 gap-1">
                    <Button size="sm" variant="ghost" onClick={() => open(doc)} aria-label={`Edit ${doc.title}`}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void toggle(doc)}>
                      {doc.active ? "Archive" : "Restore"}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {toggleError && (
          <p role="alert" className="text-sm text-destructive">
            {toggleError}
          </p>
        )}
      </SettingsSection>

      <ConfirmDialog
        open={dialog !== null}
        onOpenChange={(next) => !next && setDialog(null)}
        title={editing ? `Edit ${editing.title}` : "Add a document"}
        description="Paste plain text. The AI quotes it when a reply needs it."
        confirmLabel={editing ? "Save" : "Add document"}
        pendingLabel="Saving…"
        confirmDisabled={draft.title.trim() === "" || draft.content.trim() === ""}
        className="sm:max-w-2xl"
        onConfirm={save}
      >
        <FieldGroup>
          <div className="grid gap-group sm:grid-cols-[1fr_12rem]">
            <Field>
              <FieldLabel htmlFor="k-title">Title</FieldLabel>
              <Input id="k-title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} required maxLength={200} />
            </Field>
            <Field>
              <FieldLabel htmlFor="k-kind">Kind</FieldLabel>
              <Select items={KINDS} value={draft.kind} onValueChange={(v) => v && setDraft({ ...draft, kind: v })}>
                <SelectTrigger id="k-kind" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KINDS.map((k) => (
                    <SelectItem key={k.value} value={k.value}>
                      {k.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="k-content">Text</FieldLabel>
            <Textarea id="k-content" className="min-h-48" value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} required />
          </Field>
          <Field>
            <FieldLabel htmlFor="k-tags">Tags, comma separated</FieldLabel>
            <Input id="k-tags" value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} placeholder="pricing, onboarding" />
            <FieldDescription>Follow-up drafts receive the documents that share the most tags with the After a reply setting. Up to 50 tags, 80 characters each, lowercase.</FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <Checkbox id="k-always" checked={draft.always} onCheckedChange={(c) => setDraft({ ...draft, always: c === true })} />
            <FieldLabel htmlFor="k-always">Always include in prompts</FieldLabel>
          </Field>
        </FieldGroup>
      </ConfirmDialog>
    </div>
  );
}
