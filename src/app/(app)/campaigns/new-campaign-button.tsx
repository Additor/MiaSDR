"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldLabel, FieldLegend, FieldSet, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { callApi } from "@/app/_lib/api-client";
import { SenderPicker, type SenderOption } from "./sender-picker";

type Channel = "email" | "linkedin";
type CampaignType = "regular" | "personal";

const CHANNELS = [
  ["email", "Email", "Sent from your mailboxes"],
  ["linkedin", "LinkedIn", "Connection request, then messages"],
] as const;

const TYPES = [
  ["regular", "Regular", "Replies go to the Inbox and Actions"],
  ["personal", "Personal", "Private: replies stay out of the Inbox, Actions and the AI. Only the creator, owners and admins can read them."],
] as const;

/** A choice of two with an explanation each, as selectable tiles. */
function ChoiceTiles<T extends string>({ name, legend, options, value, onChange }: { name: string; legend: string; options: readonly (readonly [T, string, string])[]; value: T; onChange: (value: T) => void }) {
  return (
    <FieldSet>
      <FieldLegend variant="label">{legend}</FieldLegend>
      <RadioGroup value={value} onValueChange={(next) => onChange(next as T)} className="grid-cols-2">
        {options.map(([option, label, hint]) => (
          <FieldLabel key={option} htmlFor={`${name}-${option}`}>
            <Field orientation="horizontal">
              <RadioGroupItem value={option} id={`${name}-${option}`} />
              <FieldContent>
                <FieldTitle>{label}</FieldTitle>
                <FieldDescription className="text-xs">{hint}</FieldDescription>
              </FieldContent>
            </Field>
          </FieldLabel>
        ))}
      </RadioGroup>
    </FieldSet>
  );
}

export function NewCampaignButton({ senders }: { senders: { email: SenderOption[]; linkedin: SenderOption[] } }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [channel, setChannel] = useState<Channel>("email");
  const [senderIds, setSenderIds] = useState<string[]>([]);
  const [type, setType] = useState<CampaignType>("regular");

  function openDialog() {
    setName("");
    setChannel("email");
    setSenderIds([]);
    setType("regular");
    setOpen(true);
  }

  async function create() {
    const result = await callApi<{ id: string }>(
      channel === "linkedin" ? "/api/linkedin/campaigns" : "/api/campaigns",
      "POST",
      channel === "linkedin" ? { name, senderIds, type } : { name, senderIds },
    );
    // ConfirmDialog keeps the panel open and shows the reason when this throws.
    if (!result.ok || !result.data) throw new Error(result.error ?? "The campaign was not created. Try again.");
    router.push(`/campaigns/${result.data.id}`);
  }

  return (
    <>
      <Button onClick={openDialog}>New campaign</Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="New campaign"
        description={
          channel === "linkedin"
            ? "It starts as a draft with a connection request and two follow-up messages you can edit. Nothing goes out until you start it."
            : "It starts as a draft with a two-step template you can edit. Nothing is sent until you start it."
        }
        confirmLabel="Create campaign"
        pendingLabel="Creating…"
        confirmDisabled={name.trim() === ""}
        onConfirm={create}
      >
        <ChoiceTiles
          name="campaign-channel"
          legend="Channel"
          options={CHANNELS}
          value={channel}
          onChange={(next) => {
            setChannel(next);
            setSenderIds([]);
            setType("regular");
          }}
        />
        {channel === "linkedin" && <ChoiceTiles name="campaign-type" legend="Campaign type" options={TYPES} value={type} onChange={setType} />}
        <div className="stack-field">
          <Label htmlFor="campaign-name">Name</Label>
          <Input id="campaign-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Q4 outreach to CTOs" maxLength={120} autoFocus />
        </div>
        <div className="stack-field">
          <span className="text-sm font-medium">Send from</span>
          <SenderPicker options={senders[channel]} value={senderIds} onChange={setSenderIds} noun={channel === "linkedin" ? "LinkedIn account" : "mailbox"} />
        </div>
      </ConfirmDialog>
    </>
  );
}
