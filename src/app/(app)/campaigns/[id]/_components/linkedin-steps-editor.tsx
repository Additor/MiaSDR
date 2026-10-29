"use client";

import { PlusIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { callApi } from "@/app/_lib/api-client";
import { cn } from "@/components/ui/utils";
import { CampaignSection } from "./campaign-section";
import { MergeFieldPicker, UnresolvedList, useFieldInsert, useMergeFields, type UnresolvedToken } from "./merge-field-picker";

export interface LinkedInEditableStep {
  stepNumber: number;
  kind: "invitation" | "message";
  subject?: string;
  body: string;
  waitDays: number;
}

interface Preview {
  kind: "invitation" | "message";
  text: string;
  length: number;
  limit: number | null;
  overLimit: boolean;
  usedSampleLead: boolean;
  leadName: string | null;
  unresolved?: UnresolvedToken[];
}

const NOTE_MAX = 300;
const MAX_STEPS = 6;
const PLACEHOLDER = /\[\[[^\]]*\]\]/;

const renumber = (steps: LinkedInEditableStep[]): LinkedInEditableStep[] => steps.map((s, i) => ({ ...s, stepNumber: i + 1, kind: i === 0 ? "invitation" : "message" }));

export function LinkedInStepsEditor({ id, initial, editable }: { id: string; initial: LinkedInEditableStep[]; editable: boolean }) {
  const router = useRouter();
  const [steps, setSteps] = useState<LinkedInEditableStep[]>(initial);
  const [selected, setSelected] = useState(1);
  const [saving, setSaving] = useState(false);
  const [issues, setIssues] = useState<Array<{ step?: number | null; message: string }>>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const dirty = useMemo(() => JSON.stringify(steps) !== JSON.stringify(initial), [steps, initial]);
  const current = steps[Math.min(selected, steps.length) - 1];
  const fields = useMergeFields();
  const { track, insert } = useFieldInsert({
    getText: (index) => steps[index]?.body ?? "",
    setText: (index, _field, text) => update(index, { body: text }),
    idFor: (index) => `li-body-${index}`,
    fallback: () => ({ index: Math.min(selected, steps.length) - 1, field: "body" }),
  });
  const unfinished = steps.filter((s) => PLACEHOLDER.test(s.body)).map((s) => s.stepNumber);

  // Preview what is typed, not what is saved, after a short pause.
  useEffect(() => {
    if (!current) return;
    const handle = setTimeout(async () => {
      const result = await callApi<Preview>(`/api/linkedin/campaigns/${id}/preview`, "POST", { step: current.stepNumber, steps });
      setPreview(result.data);
      setPreviewError(result.ok ? null : result.error);
    }, 400);
    return () => clearTimeout(handle);
  }, [id, steps, current]);

  function update(index: number, patch: Partial<LinkedInEditableStep>) {
    setSteps((all) => all.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  async function save() {
    setSaving(true);
    setIssues([]);
    const result = await callApi(`/api/linkedin/campaigns/${id}`, "PATCH", { steps });
    setSaving(false);
    if (!result.ok) {
      setIssues(result.issues);
      toast.error(result.error ?? "Could not save.");
      return;
    }
    toast.success("Steps saved.");
    router.refresh();
  }

  return (
    <div className="grid min-w-0 lg:grid-cols-2 lg:gap-section">
      <CampaignSection
        title="Steps"
        testId="steps"
        className="lg:pb-0"
        description={
          editable
            ? "Step 1 is the connection request. The messages follow once the lead accepts. Use Insert field for {{firstName}}, {{company}} and your custom fields. {Hi|Hello} picks one at random."
            : "Pause the campaign to edit its steps."
        }
      >
        {editable && <MergeFieldPicker fields={fields} onPick={insert} />}
        <ol className="min-w-0 divide-y border-y">
          {steps.map((step, index) => {
            const active = selected === step.stepNumber;
            const raw = step.body.length;
            const shownLength = active && preview ? preview.length : raw;
            return (
              <li
                key={index}
                aria-current={active ? "step" : undefined}
                className={cn("grid min-w-0 gap-3 border-l py-4 pl-3", active ? "border-l-foreground" : "border-l-transparent")}
                onFocusCapture={() => setSelected(step.stepNumber)}
              >
                <div className="flex min-h-7 items-center justify-between gap-2">
                  <h3 className="heading-item data-[active=true]:font-semibold" data-active={active}>{index === 0 ? "Step 1: connection request" : `Step ${step.stepNumber}: message ${index}`}</h3>
                  {editable && index > 0 && (
                    <Button variant="ghost" size="icon-sm" aria-label={`Remove step ${step.stepNumber}`} onClick={() => setSteps((all) => renumber(all.filter((_, i) => i !== index)))}>
                      <Trash2Icon />
                    </Button>
                  )}
                </div>
                {index > 0 && (
                  <Field>
                    <FieldLabel htmlFor={`li-wait-${index}`}>{index === 1 ? "Send after acceptance (days, 0 sends right away)" : "Send after (days since the previous message)"}</FieldLabel>
                    <Input
                      id={`li-wait-${index}`}
                      type="number"
                      min={index === 1 ? 0 : 1}
                      max={60}
                      value={step.waitDays}
                      disabled={!editable}
                      onChange={(e) => update(index, { waitDays: Number(e.target.value) })}
                      className="w-28"
                    />
                  </Field>
                )}
                <Field>
                  <FieldLabel htmlFor={`li-body-${index}`}>{index === 0 ? "Invitation note (optional)" : "Message"}</FieldLabel>
                  <Textarea
                    id={`li-body-${index}`}
                    rows={index === 0 ? 4 : 6}
                    value={step.body}
                    disabled={!editable}
                    onChange={(e) => update(index, { body: e.target.value })}
                    onSelect={track(index, "body")}
                    onBlur={track(index, "body")}
                  />
                  {index === 0 && (
                    <p className={`text-xs ${shownLength > NOTE_MAX ? "text-destructive" : "text-muted-foreground"}`} aria-live="polite">
                      {shownLength}/{NOTE_MAX} characters after merge fields. LinkedIn cuts nothing: a longer note fails that lead.
                    </p>
                  )}
                  {PLACEHOLDER.test(step.body) && <p className="text-xs text-destructive">Replace the [[bracketed text]] before you start.</p>}
                </Field>
                {issues
                  .filter((i) => i.step === step.stepNumber)
                  .map((i) => (
                    <p key={i.message} role="alert" className="text-sm text-destructive">
                      {i.message}
                    </p>
                  ))}
              </li>
            );
          })}
        </ol>
        {issues
          .filter((i) => !i.step)
          .map((i) => (
            <p key={i.message} role="alert" className="text-sm text-destructive">
              {i.message}
            </p>
          ))}
        {unfinished.length > 0 && editable && <p className="text-sm text-muted-foreground">The campaign cannot start while step {unfinished.join(", ")} has [[bracketed text]].</p>}
        {editable && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={steps.length >= MAX_STEPS}
              onClick={() => setSteps((all) => renumber([...all, { stepNumber: all.length + 1, kind: "message", body: "", waitDays: all.length === 1 ? 1 : 3 }]))}
            >
              <PlusIcon /> Add message
            </Button>
            <Button onClick={save} disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save steps"}
            </Button>
          </div>
        )}
      </CampaignSection>

      <CampaignSection
        title={`Preview of step ${current?.stepNumber ?? 1}`}
        testId="step-preview"
        className="h-fit lg:sticky lg:top-4 lg:border-t-0 lg:pt-0"
        description={preview ? (preview.usedSampleLead ? "With a sample lead. Add leads to preview with a real one." : `With ${preview.leadName ?? "your first lead"}.`) : "Loading…"}
      >
        <div className="stack-group text-sm">
          {previewError && <p className="text-destructive">{previewError}</p>}
          {preview && (
            <>
              {preview.text === "" ? (
                <p className="text-muted-foreground">{preview.kind === "invitation" ? "No note: the request goes out blank." : "Empty message."}</p>
              ) : (
                <pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-sans">{preview.text}</pre>
              )}
              <UnresolvedList unresolved={preview.unresolved} />
              {preview.limit !== null && (
                <p className={preview.overLimit ? "text-destructive" : "text-muted-foreground"}>
                  {preview.length}/{preview.limit} characters{preview.overLimit ? ". Too long for LinkedIn." : "."}
                </p>
              )}
            </>
          )}
        </div>
      </CampaignSection>
    </div>
  );
}
