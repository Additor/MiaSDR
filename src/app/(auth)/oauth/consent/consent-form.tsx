"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Access = "read" | "write" | "send";

const LABEL: Record<Access, { title: string; detail: string }> = {
  read: { title: "Read", detail: "See what you can see in this organization." },
  write: { title: "Read and make changes", detail: "Also write drafts, tasks, notes, deals and campaign drafts. Nothing sends." },
  send: { title: "Read, make changes and send", detail: "Also send replies and start campaigns where this organization allows it, with no one reviewing first." },
};

type Extra = "spend" | "irreversible";

const EXTRA_LABEL: Record<Extra, { title: string; detail: string }> = {
  spend: { title: "Spend on enrichment and LinkedIn searches", detail: "Within this organization's daily limits, with no one reviewing first." },
  irreversible: { title: "Complete campaigns and delete records", detail: "No one can undo these. Deleting a contact erases its conversations." },
};

export interface ConsentFormProps {
  clientName: string;
  found: boolean;
  verifiedHost: string | null;
  redirectHost: string | null;
  mcpOn: boolean;
  choices: Access[];
  /** What the app asked for on top of its access. A person ticks each one; none starts ticked. */
  extras: Extra[];
  organizations: Array<{ id: string; name: string }>;
  organizationId: string;
}

/** Sending stays a choice a person makes: it is never preselected, even when the app asks for it. */
const firstChoice = (choices: Access[]): Access => (choices.includes("write") ? "write" : (choices[0] ?? "read"));

export function ConsentForm({ clientName, found, verifiedHost, redirectHost, mcpOn, choices, extras, organizations, organizationId }: ConsentFormProps) {
  const router = useRouter();
  const [access, setAccess] = useState<Access>(firstChoice(choices));
  const [ticked, setTicked] = useState<Extra[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function answer(accept: boolean) {
    setPending(true);
    setError(null);
    const result = await runApiAction(callApi<{ url: string }>("/api/oauth/consent", "POST", { oauthQuery: window.location.search.slice(1), accept, organizationId, access, extras: access === "read" ? [] : ticked }), { expectData: true });
    if (result.ok) {
      window.location.assign(result.data.url);
      return;
    }
    setPending(false);
    setError(result.error);
  }

  async function switchOrganization(id: string) {
    setPending(true);
    const result = await runApiAction(callApi("/api/organizations/active", "POST", { organizationId: id }), { refresh: () => router.refresh() });
    setPending(false);
    if (!result.ok) setError(result.error);
  }

  if (!found || !mcpOn) {
    return (
      <Card>
        <CardHeader>
          <CardTitle as="h1">{found ? "MCP is off here" : "This app is not known"}</CardTitle>
          <CardDescription>{found ? "An owner or admin turns MCP on under Settings, AI agents (MCP). You can then connect this app." : "Start connecting from the app again."}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h1">Connect {clientName}?</CardTitle>
        <CardDescription>
          {verifiedHost ? `This app is published at ${verifiedHost}.` : "This app registered itself, so MiaSDR cannot confirm its name."}
          {redirectHost ? ` You return to ${redirectHost} afterwards.` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {organizations.length > 1 ? (
          <Field>
            <FieldLabel id="consent-organization">Organization</FieldLabel>
            <Select items={organizations.map((o) => ({ value: o.id, label: o.name }))} value={organizationId} disabled={pending} onValueChange={(id) => id && void switchOrganization(id)}>
              <SelectTrigger aria-labelledby="consent-organization" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {organizations.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : (
          <p className="text-sm">Organization: {organizations[0]?.name}</p>
        )}
        <div className="space-y-2 text-sm">
          <p id="consent-access" className="font-medium">
            What it may do as you
          </p>
          <RadioGroup aria-labelledby="consent-access" value={access} onValueChange={(value) => setAccess(value as Access)}>
            {choices.map((choice) => (
              <Field key={choice} orientation="horizontal" className="items-start">
                <RadioGroupItem value={choice} id={`consent-${choice}`} />
                <FieldLabel htmlFor={`consent-${choice}`} className="block font-normal">
                  {LABEL[choice].title}
                  <span className="block text-muted-foreground">{LABEL[choice].detail}</span>
                </FieldLabel>
              </Field>
            ))}
          </RadioGroup>
          {access !== "read" &&
            extras.map((extra) => (
              <Field key={extra} orientation="horizontal" className="items-start">
                <Checkbox id={`consent-${extra}`} checked={ticked.includes(extra)} onCheckedChange={(on) => setTicked((list) => (on ? [...list, extra] : list.filter((e) => e !== extra)))} />
                <FieldLabel htmlFor={`consent-${extra}`} className="block font-normal">
                  {EXTRA_LABEL[extra].title}
                  <span className="block text-muted-foreground">{EXTRA_LABEL[extra].detail}</span>
                </FieldLabel>
              </Field>
            ))}
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={pending} onClick={() => void answer(false)}>
            Deny
          </Button>
          <Button disabled={pending || choices.length === 0} onClick={() => void answer(true)}>
            Connect
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
