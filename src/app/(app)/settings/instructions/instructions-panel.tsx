"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/shell/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { useApiAction } from "@/app/_lib/use-api-action";
import { cn } from "@/components/ui/utils";
import { SaveRow, useLeaveGuard } from "../settings-form";
import { RULED_LIST, RULED_ROW, SettingsSection } from "../settings-section";

interface Block {
  id: string;
  title: string;
  content: string;
}

const newId = () => `b${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

export function InstructionsPanel({ draft, classification, canManage }: { draft: Block[]; classification: Block[]; canManage: boolean }) {
  return (
    <>
      <BlockList
        field="draftInstructions"
        title="Drafting instructions"
        description="Added to every reply the AI drafts. Use them for tone, length, what to offer and what to avoid. They cannot override the fixed safety rules."
        initial={draft}
        canManage={canManage}
      />
      <BlockList
        field="classificationInstructions"
        title="Reply type instructions"
        description="Added each time the AI picks a reply type. Use them to explain how your sales process works and how to read ambiguous replies."
        initial={classification}
        canManage={canManage}
      />
    </>
  );
}

function BlockList({
  field,
  title,
  description,
  initial,
  canManage,
}: {
  field: "draftInstructions" | "classificationInstructions";
  title: string;
  description: string;
  initial: Block[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [blocks, setBlocks] = useState<Block[]>(initial);
  // The server trims what it saves. When its copy changes (after this list's save), start from it, so the trimmed text
  // does not read as an unsaved change. Comparing content keeps the other list's edits when only this one saved.
  const [seen, setSeen] = useState(() => JSON.stringify(initial));
  if (JSON.stringify(initial) !== seen) {
    setSeen(JSON.stringify(initial));
    setBlocks(initial);
  }
  const [error, setError] = useState<string | null>(null);
  const { isBusy, run } = useApiAction<"save">();
  const pending = isBusy("save");

  const change = (id: string, patch: Partial<Block>) => {
    setBlocks((current) => current.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  };

  // Space at either end is not a change: the server trims it away.
  const trimmed = (list: Block[]) => JSON.stringify(list.map((b) => ({ id: b.id, title: b.title.trim(), content: b.content.trim() })));
  const dirty = trimmed(blocks) !== trimmed(initial);
  useLeaveGuard(dirty);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await run("save", async () => {
      setError(null);
      return runApiAction(callApi("/api/settings/replies/ai-instructions", "PUT", { [field]: blocks }), { refresh: () => router.refresh() });
    });
    if (!result) return;
    if (!result.ok) return setError(result.error);
    toast.success(`${title} saved.`);
  }

  if (!canManage) {
    return (
      <SettingsSection title={title} description={description}>
        {blocks.length === 0 ? (
          <EmptyState className="py-0" title="No instructions yet" />
        ) : (
          <ul className={RULED_LIST} aria-label={title}>
            {blocks.map((b) => (
              <li key={b.id} className={cn(RULED_ROW, "stack-field")}>
                <h3 className="heading-item">{b.title || "Untitled"}</h3>
                <p className="text-sm whitespace-pre-wrap text-muted-foreground">{b.content}</p>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      title={title}
      description={description}
      action={
        <Button type="button" variant="outline" disabled={blocks.length >= 50} onClick={() => setBlocks((current) => [...current, { id: newId(), title: "", content: "" }])}>
          Add instruction
        </Button>
      }
    >
      <form onSubmit={save}>
        <FieldGroup>
          {blocks.length === 0 ? (
            <EmptyState className="py-0" title="No instructions yet" />
          ) : (
            <ul className={RULED_LIST} aria-label={title}>
              {blocks.map((b, index) => (
                <li key={b.id} className={cn(RULED_ROW, "stack-group")}>
                  <Field>
                    <FieldLabel htmlFor={`${b.id}-title`}>Title</FieldLabel>
                    <div className="flex items-center gap-2">
                      <Input id={`${b.id}-title`} value={b.title} onChange={(e) => change(b.id, { title: e.target.value })} maxLength={200} placeholder={`Instruction ${index + 1}`} />
                      <Button type="button" variant="ghost" size="sm" onClick={() => setBlocks((current) => current.filter((x) => x.id !== b.id))} aria-label={`Remove ${b.title || `instruction ${index + 1}`}`}>
                        Remove
                      </Button>
                    </div>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${b.id}-content`}>Instruction</FieldLabel>
                    <Textarea id={`${b.id}-content`} className="min-h-24" value={b.content} onChange={(e) => change(b.id, { content: e.target.value })} maxLength={8000} />
                  </Field>
                </li>
              ))}
            </ul>
          )}
          {(blocks.length > 0 || dirty) && <SaveRow dirty={dirty} pending={pending} error={error} onDiscard={() => setBlocks(initial)} />}
        </FieldGroup>
      </form>
    </SettingsSection>
  );
}
