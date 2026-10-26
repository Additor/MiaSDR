"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callApi } from "@/app/_lib/api-client";
import { SenderPicker, type SenderOption } from "./sender-picker";

export function NewCampaignButton({ senders }: { senders: { email: SenderOption[]; linkedin: SenderOption[] } }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [channel, setChannel] = useState<"email" | "linkedin">("email");
  const [senderIds, setSenderIds] = useState<string[]>([]);
  const [type, setType] = useState<"regular" | "personal">("regular");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const name = String(new FormData(event.currentTarget).get("name"));
    const result = await callApi<{ id: string }>(channel === "linkedin" ? "/api/linkedin/campaigns" : "/api/campaigns", "POST", channel === "linkedin" ? { name, senderIds, type } : { name, senderIds });
    setPending(false);
    if (!result.ok || !result.data) {
      setError(result.error);
      return;
    }
    setOpen(false);
    router.push(`/campaigns/${result.data.id}`);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>New campaign</DialogTrigger>
      <DialogContent>
        <form onSubmit={onSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New campaign</DialogTitle>
            <DialogDescription>
              {channel === "linkedin"
                ? "It starts as a draft with a connection request and two follow-up messages you can edit. Nothing goes out until you start it."
                : "It starts as a draft with a two-step template you can edit. Nothing is sent until you start it."}
            </DialogDescription>
          </DialogHeader>
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">Channel</legend>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ["email", "Email", "Sent from your mailboxes"],
                  ["linkedin", "LinkedIn", "Connection request, then messages"],
                ] as const
              ).map(([value, label, hint]) => (
                <label key={value} className={`flex cursor-pointer flex-col gap-0.5 rounded-lg border p-3 text-sm has-[:checked]:border-ring has-[:checked]:bg-muted/50`}>
                  <span className="flex items-center gap-2 font-medium">
                    <input type="radio" name="channel" value={value} checked={channel === value} onChange={() => {
                      setChannel(value);
                      setSenderIds([]);
                      setType("regular");
                    }}
                  />
                    {label}
                  </span>
                  <span className="text-xs text-muted-foreground">{hint}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {channel === "linkedin" && (
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">Campaign type</legend>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ["regular", "Regular", "Replies go to the Inbox and Actions"],
                    ["personal", "Personal", "Private: replies stay out of the Inbox, Actions and the AI. Only the creator, owners and admins can read them."],
                  ] as const
                ).map(([value, label, hint]) => (
                  <label key={value} className="flex cursor-pointer flex-col gap-0.5 rounded-lg border p-3 text-sm has-[:checked]:border-ring has-[:checked]:bg-muted/50">
                    <span className="flex items-center gap-2 font-medium">
                      <input type="radio" name="campaign-type" value={value} checked={type === value} onChange={() => setType(value)} />
                      {label}
                    </span>
                    <span className="text-xs text-muted-foreground">{hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <div className="grid gap-2">
            <Label htmlFor="campaign-name">Name</Label>
            <Input id="campaign-name" name="name" placeholder="Q4 outreach to CTOs" required maxLength={120} autoFocus />
          </div>
          <div className="grid gap-2">
            <span className="text-sm font-medium">Send from</span>
            <SenderPicker options={senders[channel]} value={senderIds} onChange={setSenderIds} noun={channel === "linkedin" ? "LinkedIn account" : "mailbox"} disabled={pending} />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create campaign"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
