"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ReachFlag } from "@/components/shell/reach-flag";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
      <p className="text-sm font-medium">{title}</p>
      <div className="grid gap-1">
        <Label htmlFor="compose-subject">Subject</Label>
        <Input id="compose-subject" value={subject} maxLength={MANUAL_SUBJECT_MAX} onChange={(e) => setSubject(e.target.value)} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="compose-body">Message</Label>
        <Textarea id="compose-body" className="min-h-48" value={body} maxLength={MANUAL_BODY_MAX} onChange={(e) => setBody(e.target.value)} />
      </div>
      {knownCcs.length > 0 && (
        <fieldset className="grid gap-2 rounded-lg border p-3 text-sm" data-testid="compose-cc-options">
          <legend className="px-1 text-xs text-muted-foreground">CC on this reply</legend>
          {knownCcs.map((known) => (
            <label key={known.email} className="flex items-center gap-2">
              <input
                type="checkbox"
                value={known.email}
                checked={cc.includes(known.email)}
                disabled={known.blocked !== null}
                onChange={(e) => setCc((current) => (e.target.checked ? [...current, known.email] : current.filter((c) => c !== known.email)))}
              />
              <span>{known.email}</span>
              {known.blocked && <ReachFlag kind={known.blocked} />}
            </label>
          ))}
        </fieldset>
      )}
      {disabledReason && <p className="text-sm text-destructive">{disabledReason}</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div>
        <Button size="sm" disabled={busy || disabledReason !== null || subject.trim() === "" || body.trim() === ""} onClick={create}>
          {busy ? "Saving…" : "Create draft"}
        </Button>
      </div>
    </div>
  );
}
