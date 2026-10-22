"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { callApi } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { RULED_LIST, RULED_ROW, SettingsSection } from "../settings-section";

interface Block {
  id: string;
  title: string;
  content: string;
}

const newId = () => `b${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

export function InstructionsPanel({ draft, classification }: { draft: Block[]; classification: Block[] }) {
  return (
    <>
      <BlockList
        field="draftInstructions"
        title="Drafting instructions"
        description="Added to every reply the AI drafts. Use them for tone, length, what to offer and what to avoid. They cannot override the fixed safety rules."
        initial={draft}
      />
      <BlockList
        field="classificationInstructions"
        title="Classification instructions"
        description="Added to every classification. Use them to explain how your sales process works and how to read ambiguous replies."
        initial={classification}
      />
    </>
  );
}

function BlockList({ field, title, description, initial }: { field: "draftInstructions" | "classificationInstructions"; title: string; description: string; initial: Block[] }) {
  const router = useRouter();
  const [blocks, setBlocks] = useState<Block[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const change = (id: string, patch: Partial<Block>) => {
    setBlocks((current) => current.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  };

  async function save() {
    setPending(true);
    setError(null);
    const result = await callApi("/api/settings/replies/ai-instructions", "PUT", { [field]: blocks });
    setPending(false);
    if (!result.ok) return setError(result.error);
    toast.success(`${title} saved.`);
    router.refresh();
  }

  return (
    <SettingsSection title={title} description={description}>
      {blocks.length === 0 ? (
        <p className="text-sm text-muted-foreground">No instructions yet.</p>
      ) : (
        <ul className={RULED_LIST} aria-label={title}>
          {blocks.map((b) => (
            <li key={b.id} className={cn(RULED_ROW, "stack-group")}>
              <div className="stack-field">
                <Label htmlFor={`${b.id}-title`}>Title</Label>
                <Input id={`${b.id}-title`} value={b.title} onChange={(e) => change(b.id, { title: e.target.value })} maxLength={200} />
              </div>
              <div className="stack-field">
                <Label htmlFor={`${b.id}-content`}>Instruction</Label>
                <Textarea id={`${b.id}-content`} className="min-h-24" value={b.content} onChange={(e) => change(b.id, { content: e.target.value })} maxLength={8000} />
              </div>
              <div>
                <Button size="xs" variant="ghost" onClick={() => setBlocks((current) => current.filter((x) => x.id !== b.id))}>
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={blocks.length >= 50} onClick={() => setBlocks((current) => [...current, { id: newId(), title: "", content: "" }])}>
          Add instruction
        </Button>
        <Button size="sm" disabled={pending} onClick={save}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </SettingsSection>
  );
}
