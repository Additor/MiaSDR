"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Count } from "@/components/shell/section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { CATCH_ALL_TYPE_KEY, REPLY_TYPE_GROUPS } from "@/contexts/conversations/domain/reply-handling";
import { DEFAULT_TYPE_RULES, SYSTEM_ROLE_REASONS, type CheckMode, type FollowUpsRule, type SystemRole, type TypeRules } from "@/contexts/conversations/domain/reply-type";
import { rulesSummary } from "@/app/(app)/inbox/[id]/_lib/type-line";
import { runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { toastOrThrow, useApiAction } from "@/app/_lib/use-api-action";
import { countOf, formatCount } from "@/shared/format-number";
import { cn } from "@/components/ui/utils";
import { RULED_LIST, RULED_ROW, SettingsSection } from "../settings-section";

interface ReplyTypeItem {
  id: string;
  groupKey: string;
  key: string;
  name: string;
  description: string | null;
  classificationGuidance: string | null;
  active: boolean;
  rules: TypeRules;
  systemRole: SystemRole | null;
  recordCount: number;
  historyCount: number;
}

interface Draft {
  groupKey: string;
  name: string;
  description: string;
  guidance: string;
  rules: TypeRules;
}

const GROUP_ITEMS = REPLY_TYPE_GROUPS.map((g) => ({ value: g.key, label: g.label }));

/** The Check choice, as the dialog offers it and as a row's summary names it. */
const CHECK_OPTIONS: Array<{ value: CheckMode; label: string; description: string; summary: string }> = [
  { value: "before", label: "Before it applies", description: "The pick waits until a person accepts it.", summary: "Check before" },
  { value: "after", label: "After it applies", description: "The pick applies at once, and a person marks it Looks right.", summary: "Check after" },
  { value: "skip", label: "Skip", description: "The pick applies at once and nobody checks it.", summary: "No check" },
];

/** "Check before · Draft · Follow-ups keep going": what a type does when the AI picks it. */
const typeSummary = (rules: TypeRules) => `${CHECK_OPTIONS.find((o) => o.value === rules.checkMode)?.summary ?? "Check before"} · ${rulesSummary(rules)}`;

const archiveRecords = (count: number) => (count === 0 ? "Nobody has this type now." : `${formatCount(count)} ${count === 1 ? "person keeps" : "people keep"} this type.`);

const draftOf = (type: ReplyTypeItem | null, groupKey = "interested"): Draft => ({
  groupKey: type?.groupKey ?? groupKey,
  name: type?.name ?? "",
  description: type?.description ?? "",
  guidance: type?.classificationGuidance ?? "",
  rules: { ...(type?.rules ?? DEFAULT_TYPE_RULES) },
});

export function ReplyTypesPanel({ replyTypes, canManage }: { replyTypes: ReplyTypeItem[]; canManage: boolean }) {
  const router = useRouter();
  // `editing` null with the dialog open adds a reply type.
  const [dialog, setDialog] = useState<{ editing: ReplyTypeItem | null } | null>(null);
  const [draft, setDraft] = useState<Draft>(draftOf(null));
  const [confirming, setConfirming] = useState<{ type: ReplyTypeItem; action: "archive" | "delete" } | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const { busy, run } = useApiAction();
  const refresh = () => router.refresh();
  // Where the AI sends a reply that would have fit an archived type: the catch-all of the Other group, when it is active.
  const fallback = replyTypes.find((t) => t.key === CATCH_ALL_TYPE_KEY && t.active)?.name ?? null;

  function open(type: ReplyTypeItem | null) {
    setDraft(draftOf(type));
    setDialog({ editing: type });
  }

  async function save() {
    const editing = dialog?.editing ?? null;
    // A stop request keeps fixed rules, so its dialog sends none.
    const rules = editing?.systemRole === "stop_request" ? {} : draft.rules;
    const common = {
      name: draft.name,
      description: draft.description.trim() || null,
      classificationGuidance: draft.guidance.trim() || null,
      ...rules,
    };
    const call = editing ? callApi(`/api/reply-types/${editing.id}`, "PATCH", common) : callApi("/api/reply-types", "POST", { ...common, groupKey: draft.groupKey });
    toastOrThrow(await runApiAction(call, { refresh }), editing ? `${draft.name} saved.` : `${draft.name} added.`);
  }

  /** Archive and restore. A failure throws so the confirmation dialog can show it; Restore has no dialog and reports below the list. */
  async function toggle(type: ReplyTypeItem) {
    toastOrThrow(await runApiAction(callApi(`/api/reply-types/${type.id}`, "PATCH", { active: !type.active }), { refresh }), type.active ? `${type.name} archived.` : `${type.name} restored.`);
  }

  async function remove(type: ReplyTypeItem) {
    toastOrThrow(await runApiAction(callApi(`/api/reply-types/${type.id}`, "DELETE"), { refresh }), `${type.name} deleted.`);
  }

  const restore = (type: ReplyTypeItem) =>
    run(type.id, async () => {
      setRestoreError(null);
      await toggle(type).catch((e: unknown) => setRestoreError(e instanceof Error ? e.message : "Something went wrong. Try again."));
    });

  const setRules = (patch: Partial<TypeRules>) => setDraft((d) => ({ ...d, rules: { ...d.rules, ...patch } }));
  const editing = dialog?.editing ?? null;
  const typeName = draft.name.trim() || "this type";

  return (
    <>
      {/* Two levels only: a group is an h3, its reply types are the rows of one ruled list. */}
      <SettingsSection
        title="Reply types"
        description="The four groups are fixed. The AI picks one reply type for each reply, from its name, description and guidance."
        action={
          canManage ? (
            <Button variant="outline" onClick={() => open(null)}>
              Add reply type
            </Button>
          ) : undefined
        }
      >
        <div className="stack-section">
          {REPLY_TYPE_GROUPS.map((g) => {
            const types = replyTypes.filter((t) => t.groupKey === g.key);
            return (
              <div key={g.key} className="stack-group" data-testid={`group-${g.key}`}>
                <h3 className="heading-item">{g.label}</h3>
                {types.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No reply types.</p>
                ) : (
                  <ul className={RULED_LIST} aria-label={`${g.label} reply types`}>
                    {types.map((t) => (
                      <li key={t.id} data-testid="reply-type-row" className={cn(RULED_ROW, "flex flex-wrap items-start gap-x-3 gap-y-1 text-sm")}>
                        <div className="grid min-w-0 flex-1 basis-full gap-1 sm:basis-64">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{t.name}</span>
                            {t.systemRole === "customer" && <Badge variant="secondary">Locked</Badge>}
                            {!t.active && <Badge variant="secondary">Archived</Badge>}
                            <Count value={countOf(t.recordCount, "person", "people")} />
                          </div>
                          <p className="text-muted-foreground" data-testid="reply-type-rules">
                            {typeSummary(t.rules)}
                          </p>
                          {t.systemRole && <p className="text-muted-foreground">{SYSTEM_ROLE_REASONS[t.systemRole]}</p>}
                          {t.description && <p className="text-muted-foreground">{t.description}</p>}
                          {t.classificationGuidance && <p className="whitespace-pre-wrap text-muted-foreground">Guidance: {t.classificationGuidance}</p>}
                        </div>
                        {canManage && (
                          <div className="flex shrink-0 gap-1">
                            <Button size="sm" variant="ghost" onClick={() => open(t)} aria-label={`Edit ${t.name}`}>
                              Edit
                            </Button>
                            {/* A system-role type can be neither archived nor deleted. */}
                            {!t.systemRole && (
                              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => (t.active ? setConfirming({ type: t, action: "archive" }) : void restore(t))}>
                                {busy === t.id ? "Restoring…" : t.active ? "Archive" : "Restore"}
                              </Button>
                            )}
                            {!t.systemRole && t.recordCount === 0 && t.historyCount === 0 && (
                              <Button size="sm" variant="ghost" onClick={() => setConfirming({ type: t, action: "delete" })}>
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
        title={editing ? `Edit ${editing.name}` : "Add a reply type"}
        description="The AI reads the name, the description and the guidance when it picks a type for a reply."
        confirmLabel={editing ? "Save" : "Add reply type"}
        pendingLabel="Saving…"
        confirmDisabled={draft.name.trim() === ""}
        className="sm:max-w-lg"
        onConfirm={save}
      >
        <FieldGroup>
          {!editing && (
            <Field className="w-auto">
              <FieldLabel htmlFor="type-group">Group</FieldLabel>
              <Select items={GROUP_ITEMS} value={draft.groupKey} onValueChange={(v) => v && setDraft({ ...draft, groupKey: v })}>
                <SelectTrigger id="type-group" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GROUP_ITEMS.map((g) => (
                    <SelectItem key={g.value} value={g.value}>
                      {g.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor="type-name">Name</FieldLabel>
            <Input id="type-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required maxLength={100} />
          </Field>
          <Field>
            <FieldLabel htmlFor="type-description">Description (optional)</FieldLabel>
            <Input id="type-description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} maxLength={500} />
          </Field>
          <Field>
            <FieldLabel htmlFor="type-guidance">AI guidance (optional)</FieldLabel>
            <Textarea id="type-guidance" value={draft.guidance} onChange={(e) => setDraft({ ...draft, guidance: e.target.value })} maxLength={2000} placeholder="Choose this when the sender asks for pricing or a quote." />
            <FieldDescription>When the AI should pick this type over the others.</FieldDescription>
          </Field>
          <FieldSet>
            <FieldLegend>When the AI picks {typeName}</FieldLegend>
            {editing?.systemRole === "stop_request" ? (
              <div className="stack-field text-sm">
                <p>{typeSummary(editing.rules)}</p>
                <p className="text-muted-foreground">{SYSTEM_ROLE_REASONS.stop_request}</p>
              </div>
            ) : (
              <>
                <FieldDescription>Applies to replies picked from now on.</FieldDescription>
                <RuleChoice
                  id="type-check"
                  legend="Check"
                  description="Below the confidence floor, a pick waits for a person whatever this says."
                  value={draft.rules.checkMode}
                  onChange={(checkMode) => setRules({ checkMode })}
                  options={CHECK_OPTIONS}
                />
                <RuleChoice
                  id="type-draft"
                  legend="Reply draft"
                  inline
                  value={draft.rules.replyDraft ? "write" : "none"}
                  onChange={(v) => setRules({ replyDraft: v === "write" })}
                  options={[
                    { value: "write", label: "Write one" },
                    { value: "none", label: "Don't write" },
                  ]}
                />
                <RuleChoice<FollowUpsRule>
                  id="type-follow-ups"
                  legend="Follow-ups"
                  description="Only in campaigns that draft follow-ups after a reply."
                  inline
                  value={draft.rules.followUps}
                  onChange={(followUps) => setRules({ followUps })}
                  options={[
                    { value: "continue", label: "Keep going" },
                    { value: "stop", label: "Stop" },
                  ]}
                />
              </>
            )}
          </FieldSet>
        </FieldGroup>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={confirming ? `${confirming.action === "archive" ? "Archive" : "Delete"} ${confirming.type.name}?` : "Archive reply type?"}
        description={
          confirming?.action === "delete"
            ? "Nobody has this type and no AI pick names it. Deleting removes it for good."
            : `${archiveRecords(confirming?.type.recordCount ?? 0)} The AI stops picking ${confirming?.type.name ?? "it"}, and a reply that would fit it goes to the closest other type${fallback ? `, often ${fallback}` : ""}. Restore it any time.`
        }
        confirmLabel={confirming?.action === "delete" ? "Delete reply type" : "Archive reply type"}
        cancelLabel={confirming?.action === "delete" ? "Keep reply type" : "Cancel"}
        pendingLabel={confirming?.action === "delete" ? "Deleting…" : "Archiving…"}
        destructive={confirming?.action === "delete"}
        onConfirm={() => confirming && (confirming.action === "delete" ? remove(confirming.type) : toggle(confirming.type))}
      />
    </>
  );
}

/** One type rule as a radio group under its own legend. `inline` sets short options side by side. */
function RuleChoice<T extends string>({
  id,
  legend,
  description,
  inline = false,
  value,
  onChange,
  options,
}: {
  id: string;
  legend: string;
  description?: string;
  inline?: boolean;
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string; description?: string }>;
}) {
  return (
    <FieldSet>
      <FieldLegend variant="label" id={`${id}-legend`}>
        {legend}
      </FieldLegend>
      {description && <FieldDescription>{description}</FieldDescription>}
      <RadioGroup aria-labelledby={`${id}-legend`} value={value} onValueChange={(v) => onChange(v as T)} className={cn(inline && "flex flex-wrap gap-x-6")}>
        {options.map((o) => (
          <Field key={o.value} orientation="horizontal" className={cn(inline && "w-auto")}>
            <RadioGroupItem value={o.value} id={`${id}-${o.value}`} />
            {o.description ? (
              <FieldContent>
                <FieldLabel htmlFor={`${id}-${o.value}`}>{o.label}</FieldLabel>
                <FieldDescription>{o.description}</FieldDescription>
              </FieldContent>
            ) : (
              <FieldLabel htmlFor={`${id}-${o.value}`}>{o.label}</FieldLabel>
            )}
          </Field>
        ))}
      </RadioGroup>
    </FieldSet>
  );
}
