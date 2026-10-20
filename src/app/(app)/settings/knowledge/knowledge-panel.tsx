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
import { callApi } from "@/lib/api-client";
import { splitTagInput } from "@/contexts/conversations/ai/domain/knowledge";
import { cn } from "@/lib/utils";
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

export function KnowledgePanel({ docs }: { docs: Doc[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<Doc | null>(null);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("custom");
  const [content, setContent] = useState("");
  const [always, setAlways] = useState(false);
  const [tags, setTags] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function edit(doc: Doc | null) {
    setEditing(doc);
    setTitle(doc?.title ?? "");
    setKind(doc?.kind ?? "custom");
    setContent(doc?.content ?? "");
    setAlways(doc?.alwaysInclude ?? false);
    setTags((doc?.tags ?? []).join(", "));
    setError(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    const result = editing
      ? await callApi(`/api/knowledge/${editing.id}`, "PATCH", { title, kind, content, alwaysInclude: always, tags: splitTagInput(tags) })
      : await callApi("/api/knowledge", "POST", { title, kind, content, alwaysInclude: always, tags: splitTagInput(tags) });
    setPending(false);
    if (!result.ok) return setError(result.error);
    toast.success(editing ? "Document saved." : "Document added.");
    edit(null);
    router.refresh();
  }

  async function toggle(doc: Doc) {
    const result = await callApi(`/api/knowledge/${doc.id}`, "PATCH", { active: !doc.active });
    if (!result.ok) return setError(result.error);
    toast.success(doc.active ? `${doc.title} archived.` : `${doc.title} restored.`);
    router.refresh();
  }

  return (
    <div>
      <SettingsSection title={editing ? `Edit ${editing.title}` : "Add a document"} description="Paste text. Each change to the text keeps the earlier version, so past drafts still cite what the AI saw.">
        <form onSubmit={save} className="stack-group">
          <div className="stack-field">
            <Label htmlFor="k-title">Title</Label>
            <Input id="k-title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
          </div>
          <div className="stack-field">
            <Label htmlFor="k-kind">Kind</Label>
            <Select items={KINDS} value={kind} onValueChange={(v) => v && setKind(v)}>
              <SelectTrigger id="k-kind" className="w-48">
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
          </div>
          <div className="stack-field">
            <Label htmlFor="k-content">Text</Label>
            <Textarea id="k-content" className="min-h-40" value={content} onChange={(e) => setContent(e.target.value)} required />
          </div>
          <div className="stack-field">
            <Label htmlFor="k-tags">Tags, comma separated</Label>
            <Input id="k-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="pricing, onboarding" />
            <p className="text-sm text-muted-foreground">Follow-up drafts receive the documents that share the most tags with the After a reply setting. Up to 50 tags, 80 characters each, lowercase.</p>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="k-always" checked={always} onCheckedChange={(c) => setAlways(c === true)} />
            <Label htmlFor="k-always">Always include in prompts</Label>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : editing ? "Save changes" : "Add document"}
            </Button>
            {editing && (
              <Button type="button" variant="ghost" onClick={() => edit(null)}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      </SettingsSection>

      {docs.length > 0 && (
        <SettingsSection title="Documents">
          <ul className={RULED_LIST}>
            {docs.map((doc) => (
              <li key={doc.id} data-testid="knowledge-doc" className={cn(RULED_ROW, "stack-group", !doc.active && "opacity-60")}>
                <div className="stack-field">
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
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => edit(doc)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => toggle(doc)}>
                    {doc.active ? "Archive" : "Restore"}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </SettingsSection>
      )}
    </div>
  );
}
