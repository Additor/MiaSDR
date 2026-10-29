"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ReachFlag } from "@/components/shell/reach-flag";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MANUAL_BODY_MAX, MANUAL_SUBJECT_MAX } from "@/contexts/conversations/domain/manual-reply";
import { callApi } from "@/app/_lib/api-client";

interface KnownCcOption {
  email: string;
  blocked: "suppressed" | "do_not_contact" | null;
}

/**
 * Hand-typed reply. It needs no AI key: "Create draft" saves the text as an ordinary draft awaiting review, and the
 * draft editor above it handles review, CC edits and "Approve and send". `defaultBody` starts it from other text, such as
 * an out-of-date draft the person chose to edit.
 */
export function ReplyComposer({
  conversationId,
  defaultSubject,
  defaultBody = "",
  title = "Write the reply yourself",
  knownCcs,
  disabledReason,
}: {
  conversationId: string;
  defaultSubject: string;
  defaultBody?: string;
  title?: string;
  knownCcs: KnownCcOption[];
  disabledReason: string | null;
}) {
  const router = useRouter();
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState(defaultBody);
  const [cc, setCc] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    const result = await callApi(`/api/inbox/${conversationId}/draft`, "POST", { subject, bodyText: body, ...(cc.length > 0 ? { cc } : {}) });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setBody("");
    setCc([]);
    router.refresh();
  }

  return (
    <div className="grid gap-3" data-testid="reply-composer">
      <p className="heading-item">{title}</p>
      <Field>
        <FieldLabel htmlFor="compose-subject">Subject</FieldLabel>
        <Input id="compose-subject" value={subject} maxLength={MANUAL_SUBJECT_MAX} onChange={(e) => setSubject(e.target.value)} />
      </Field>
      <Field>
        <FieldLabel htmlFor="compose-body">Message</FieldLabel>
        <Textarea id="compose-body" className="min-h-48" value={body} maxLength={MANUAL_BODY_MAX} onChange={(e) => setBody(e.target.value)} />
      </Field>
      {knownCcs.length > 0 && (
        // A plain fieldset with its legend as a label, no box, as in the draft editor.
        <FieldSet className="gap-field" data-testid="compose-cc-options">
          <FieldLegend variant="label" className="mb-0">
            CC on this reply
          </FieldLegend>
          {knownCcs.map((known) => (
            <Field key={known.email} orientation="horizontal" className="min-h-8 w-auto max-sm:min-h-11">
              <Checkbox
                id={`compose-cc-${known.email}`}
                value={known.email}
                checked={cc.includes(known.email)}
                disabled={known.blocked !== null}
                onCheckedChange={(checked) => setCc((current) => (checked === true ? [...current, known.email] : current.filter((c) => c !== known.email)))}
              />
              <FieldLabel htmlFor={`compose-cc-${known.email}`} className="font-normal">
                {known.email}
              </FieldLabel>
              {known.blocked && <ReachFlag kind={known.blocked} />}
            </Field>
          ))}
        </FieldSet>
      )}
      {disabledReason && <p className="text-sm text-destructive">{disabledReason}</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div>
        <Button size="sm" touch disabled={busy || disabledReason !== null || subject.trim() === "" || body.trim() === ""} onClick={create}>
          {busy ? "Saving…" : "Create draft"}
        </Button>
      </div>
    </div>
  );
}
