"use client";

import { PlusIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { useApiAction } from "@/app/_lib/use-api-action";
import { cn } from "@/components/ui/utils";
import { CampaignSection } from "./campaign-section";
import { MergeFieldPicker, UnresolvedList, useFieldInsert, useMergeFields, type UnresolvedToken } from "./merge-field-picker";

export interface EditableStep {
  stepNumber: number;
  kind: "email";
  subject?: string;
  body: string;
  waitDays: number;
}

interface Preview {
  subject: string;
  bodyText: string;
  usedSampleLead: boolean;
  leadName: string | null;
  unresolved?: UnresolvedToken[];
}

const renumber = (steps: EditableStep[]): EditableStep[] => steps.map((s, i) => ({ ...s, stepNumber: i + 1 }));

export function StepsEditor({ id, initial, editable }: { id: string; initial: EditableStep[]; editable: boolean }) {
  const router = useRouter();
  const [steps, setSteps] = useState<EditableStep[]>(initial);
  const [selected, setSelected] = useState(1);
  const { isBusy, run } = useApiAction<"save">();
  const saving = isBusy("save");
  const [issues, setIssues] = useState<Array<{ step?: number | null; message: string }>>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const dirty = useMemo(() => JSON.stringify(steps) !== JSON.stringify(initial), [steps, initial]);
  const current = steps[Math.min(selected, steps.length) - 1];
  const fields = useMergeFields();
  const { track, insert } = useFieldInsert({
    getText: (index, field) => (field === "subject" ? (steps[index]?.subject ?? "") : (steps[index]?.body ?? "")),
    setText: (index, field, text) => update(index, field === "subject" ? { subject: text } : { body: text }),
    idFor: (index, field) => `${field}-${index}`,
    fallback: () => ({ index: Math.min(selected, steps.length) - 1, field: "body" }),
  });

  // Preview what is typed, not what is saved, after a short pause.
  useEffect(() => {
    if (!current) return;
    const handle = setTimeout(async () => {
      // A preview reads; it changes nothing, so it reloads nothing.
      const result = await runApiAction(callApi<Preview>(`/api/campaigns/${id}/preview`, "POST", { step: current.stepNumber, steps }));
      setPreview(result.ok ? result.data : null);
      setPreviewError(result.ok ? null : result.error);
    }, 400);
    return () => clearTimeout(handle);
  }, [id, steps, current]);

  function update(index: number, patch: Partial<EditableStep>) {
    setSteps((all) => all.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  const save = () =>
    run("save", async () => {
      setIssues([]);
      const result = await runApiAction(callApi(`/api/campaigns/${id}`, "PATCH", { steps }), { refresh: () => router.refresh() });
      if (!result.ok) {
        setIssues(result.issues);
        toast.error(result.error);
        return;
      }
      toast.success("Steps saved.");
    });

  return (
    <div className="grid min-w-0 lg:grid-cols-2 lg:gap-section">
      <CampaignSection
        title="Steps"
        testId="steps"
        className="lg:pb-0"
        description={
          editable
            ? "Use Insert field for {{firstName}}, {{company}} and your custom fields. {Hi|Hello} picks one at random. %signature% places your signature. Leave a follow-up's subject empty to reply in the same thread."
            : "Pause the campaign to edit its steps."
        }
      >
        {editable && <MergeFieldPicker fields={fields} onPick={insert} />}
        <ol className="min-w-0 divide-y border-y">
          {steps.map((step, index) => {
            const active = selected === step.stepNumber;
            return (
              <li
                key={index}
                aria-current={active ? "step" : undefined}
                className={cn("grid min-w-0 gap-3 border-l py-4 pl-3", active ? "border-l-foreground" : "border-l-transparent")}
                onFocusCapture={() => setSelected(step.stepNumber)}
              >
                <div className="flex min-h-7 items-center justify-between gap-2">
                  <h3 className="heading-item data-[active=true]:font-semibold" data-active={active}>Step {step.stepNumber}</h3>
                  {editable && steps.length > 1 && (
                    <Button variant="ghost" size="icon-sm" aria-label={`Remove step ${step.stepNumber}`} onClick={() => setSteps((all) => renumber(all.filter((_, i) => i !== index)))}>
                      <Trash2Icon />
                    </Button>
                  )}
                </div>
                {index > 0 && (
                  <Field>
                    <FieldLabel htmlFor={`wait-${index}`}>Send after (days since the previous step)</FieldLabel>
                    <Input id={`wait-${index}`} type="number" min={1} max={60} value={step.waitDays} disabled={!editable} onChange={(e) => update(index, { waitDays: Number(e.target.value) })} className="w-28" />
                  </Field>
                )}
                <Field>
                  <FieldLabel htmlFor={`subject-${index}`}>Subject{index > 0 ? " (optional)" : ""}</FieldLabel>
                  <Input id={`subject-${index}`} value={step.subject ?? ""} disabled={!editable} onChange={(e) => update(index, { subject: e.target.value })} onSelect={track(index, "subject")} onBlur={track(index, "subject")} />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`body-${index}`}>Message</FieldLabel>
                  <Textarea id={`body-${index}`} rows={7} value={step.body} disabled={!editable} onChange={(e) => update(index, { body: e.target.value })} onSelect={track(index, "body")} onBlur={track(index, "body")} />
                </Field>
                {issues.filter((i) => i.step === step.stepNumber).map((i) => (
                  <p key={i.message} role="alert" className="text-sm text-destructive">
                    {i.message}
                  </p>
                ))}
              </li>
            );
          })}
        </ol>
        {issues.filter((i) => !i.step).map((i) => (
          <p key={i.message} role="alert" className="text-sm text-destructive">
            {i.message}
          </p>
        ))}
        {editable && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={steps.length >= 10} onClick={() => setSteps((all) => renumber([...all, { stepNumber: all.length + 1, kind: "email", subject: "", body: "", waitDays: 3 }]))}>
              <PlusIcon /> Add follow-up
            </Button>
            <Button onClick={() => void save()} disabled={!dirty || saving}>
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
              <p className="break-words">
                <span className="text-muted-foreground">Subject: </span>
                {preview.subject}
              </p>
              <pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-sans">{preview.bodyText}</pre>
              {current?.stepNumber === 1 && preview.subject === "(reply in the same thread)" && (
                <p role="alert" className="text-destructive">
                  Step 1 needs a subject that renders to text. A first email has no thread to reply in, so the campaign cannot start.
                </p>
              )}
              <UnresolvedList unresolved={preview.unresolved} />
            </>
          )}
        </div>
      </CampaignSection>
    </div>
  );
}
