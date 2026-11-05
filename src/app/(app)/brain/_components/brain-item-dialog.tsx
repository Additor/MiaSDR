"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { orThrow, runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { BRAIN_FIELDS, type BrainField, type BrainFields } from "@/contexts/brain/domain/brain-fields";
import { MAX_DESCRIPTION, MAX_TITLE } from "@/contexts/brain/domain/brain-item";
import { BRAIN_ITEM_KINDS, BRAIN_KIND_LABELS, SINGLE_ITEM_KIND, isBrainItemKind, type BrainItemKind, type BrainKind } from "@/contexts/brain/domain/brain-kinds";
import { MAX_TAGS, MAX_TAG_LENGTH, splitTagInput } from "@/contexts/brain/domain/brain-tags";
import { isPromptKind } from "@/contexts/conversations/ai/domain/knowledge";
import { fieldsOf, formValuesOf, requiredFilled, type BrainFormValues } from "../_lib/brain-form";

/** What the dialog edits. Null adds an item. */
export interface BrainDialogItem {
  id: string;
  kind: BrainKind;
  title: string;
  description: string | null;
  tags: string[];
  alwaysInclude: boolean;
  /** The pasted text of a document from before the kinds existed, which this edit sorts into a kind. */
  legacyText: string | null;
  structuredData: BrainFields | null;
}

const FIRST_KIND: BrainItemKind = "product";

interface Draft {
  kind: BrainItemKind;
  title: string;
  description: string;
  tags: string;
  always: boolean;
  values: BrainFormValues;
}

function draftOf(item: BrainDialogItem | null, startKind: BrainItemKind): Draft {
  const kind = item && isBrainItemKind(item.kind) ? item.kind : startKind;
  return {
    kind,
    title: item?.title ?? "",
    description: item?.description ?? "",
    tags: (item?.tags ?? []).join(", "),
    always: item?.alwaysInclude ?? false,
    values: formValuesOf(kind, item?.structuredData ?? null),
  };
}

function FieldInput({ field, id, value, onChange }: { field: BrainField; id: string; value: string; onChange: (value: string) => void }) {
  if (field.type === "enum") {
    const items = [{ value: "", label: "None" }, ...(field.options ?? [])];
    return (
      <Select items={items} value={value} onValueChange={(next) => onChange(next ?? "")}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (field.type === "list") return <Textarea id={id} className="min-h-24" value={value} onChange={(e) => onChange(e.target.value)} />;
  if (field.type === "number") return <Input id={id} type="number" min={0} step="any" value={value} onChange={(e) => onChange(e.target.value)} />;
  if (field.type === "currency") return <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} maxLength={3} placeholder="USD" />;
  if (field.type === "url") return <Input id={id} type="url" value={value} onChange={(e) => onChange(e.target.value)} maxLength={field.max} placeholder="https://" />;
  if ((field.max ?? 0) > MAX_TITLE) return <Textarea id={id} className="min-h-24" value={value} onChange={(e) => onChange(e.target.value)} maxLength={field.max} required={field.required} />;
  return <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} maxLength={field.max} required={field.required} />;
}

/**
 * Add and Edit share this form, which the kind's field list draws. Editing a document from before the kinds existed
 * shows its text and asks for a kind, which sorts it. The company profile leaves the kind list once one is active.
 */
export function BrainItemDialog({ open, onOpenChange, item, hasCompanyProfile }: { open: boolean; onOpenChange: (open: boolean) => void; item: BrainDialogItem | null; hasCompanyProfile: boolean }) {
  const router = useRouter();
  const id = useId();
  const [draft, setDraft] = useState<Draft>(() => draftOf(item, FIRST_KIND));
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setDraft(draftOf(item, FIRST_KIND));
  }

  const sorting = item?.legacyText !== null && item !== null;
  const picksKind = item === null || sorting;
  const kinds = BRAIN_ITEM_KINDS.filter((kind) => kind !== SINGLE_ITEM_KIND || !hasCompanyProfile || item?.kind === SINGLE_ITEM_KIND);
  const kindItems = kinds.map((kind) => ({ value: kind, label: BRAIN_KIND_LABELS[kind] }));
  const definition = BRAIN_FIELDS[draft.kind];
  const needsTitle = definition.titleField === undefined;
  const promptKind = isPromptKind(draft.kind);

  const setKind = (kind: BrainItemKind) => setDraft({ ...draft, kind, values: formValuesOf(kind, null), always: isPromptKind(kind) && draft.always });
  const setValue = (key: string, value: string) => setDraft({ ...draft, values: { ...draft.values, [key]: value } });

  async function save() {
    const body = {
      fields: fieldsOf(draft.kind, draft.values),
      description: draft.description,
      ...(needsTitle ? { title: draft.title } : {}),
      ...(promptKind ? { tags: splitTagInput(draft.tags), alwaysInclude: draft.always } : {}),
    };
    const refresh = () => router.refresh();
    if (item === null) orThrow(await runApiAction(callApi("/api/brain", "POST", { ...body, kind: draft.kind }), { refresh }));
    else orThrow(await runApiAction(callApi(`/api/brain/${item.id}`, "PATCH", { ...body, ...(sorting ? { kind: draft.kind } : {}) }), { refresh }));
    toast.success(item === null ? `${BRAIN_KIND_LABELS[draft.kind]} added.` : `${BRAIN_KIND_LABELS[draft.kind]} saved.`);
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={item === null ? "Add to Brain" : sorting ? `Sort ${item.title}` : `Edit ${item.title}`}
      description={sorting ? "Choose a kind and move the text into its fields. The old text stays as an earlier version." : "Each change to the fields keeps the earlier version, so past drafts still cite what the AI saw."}
      confirmLabel={item === null ? "Add" : "Save"}
      pendingLabel="Saving…"
      confirmDisabled={!requiredFilled(draft.kind, draft.values) || (needsTitle && draft.title.trim() === "")}
      className="sm:max-w-2xl"
      onConfirm={save}
    >
      <FieldGroup>
        {sorting && (
          <Field>
            <FieldLabel>Pasted text</FieldLabel>
            <p data-testid="brain-legacy-text" className="max-h-48 overflow-y-auto rounded-md border p-2 text-sm whitespace-pre-wrap text-muted-foreground">
              {item.legacyText}
            </p>
          </Field>
        )}
        {picksKind && (
          <Field>
            <FieldLabel htmlFor={`${id}-kind`}>Kind</FieldLabel>
            <Select items={kindItems} value={draft.kind} onValueChange={(next) => next && setKind(next as BrainItemKind)}>
              <SelectTrigger id={`${id}-kind`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {kindItems.map((kind) => (
                  <SelectItem key={kind.value} value={kind.value}>
                    {kind.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!promptKind && <FieldDescription>AI drafts don&apos;t use this kind yet.</FieldDescription>}
          </Field>
        )}
        {needsTitle && (
          <Field>
            <FieldLabel htmlFor={`${id}-title`}>Title</FieldLabel>
            <Input id={`${id}-title`} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} maxLength={MAX_TITLE} required />
          </Field>
        )}
        {definition.fields.map((field) => (
          <Field key={field.key}>
            <FieldLabel htmlFor={`${id}-${field.key}`}>{field.label}</FieldLabel>
            <FieldInput field={field} id={`${id}-${field.key}`} value={draft.values[field.key] ?? ""} onChange={(value) => setValue(field.key, value)} />
            {field.type === "list" && <FieldDescription>One per line.</FieldDescription>}
          </Field>
        ))}
        <Field>
          <FieldLabel htmlFor={`${id}-description`}>Short description</FieldLabel>
          <Input id={`${id}-description`} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} maxLength={MAX_DESCRIPTION} />
        </Field>
        {promptKind && (
          <>
            <Field>
              <FieldLabel htmlFor={`${id}-tags`}>Tags, comma separated</FieldLabel>
              <Input id={`${id}-tags`} value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} placeholder="pricing, onboarding" />
              <FieldDescription>Follow-up drafts receive the items that share the most tags with the Follow-ups after a reply setting. Up to {MAX_TAGS} tags, {MAX_TAG_LENGTH} characters each.</FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <Checkbox id={`${id}-always`} checked={draft.always} onCheckedChange={(checked) => setDraft({ ...draft, always: checked === true })} />
              <FieldLabel htmlFor={`${id}-always`}>Always include in prompts</FieldLabel>
            </Field>
          </>
        )}
      </FieldGroup>
    </ConfirmDialog>
  );
}
