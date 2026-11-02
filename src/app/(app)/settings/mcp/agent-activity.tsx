"use client";

import Link from "next/link";
import { useState } from "react";
import { EmptyState } from "@/components/shell/empty-state";
import { Time } from "@/components/shell/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { callApi } from "@/app/_lib/api-client";
import { RULED_LIST, RULED_ROW, SettingsSection } from "../settings-section";

export interface ActivityCall {
  id: string;
  tool: string;
  action: string | null;
  kind: "read" | "write";
  target: Record<string, string>;
  errorCode: string | null;
  clientName: string | null;
  createdAt: string;
  tokenName: string;
  userName: string;
}

interface Page {
  calls: ActivityCall[];
  more: boolean;
}

/** `write_reply_draft` and `edit` read "Write reply draft: edit". */
const toolLabel = (call: ActivityCall) => {
  const name = call.tool.replaceAll("_", " ");
  const label = name.charAt(0).toUpperCase() + name.slice(1);
  return call.action ? `${label}: ${call.action.replaceAll("_", " ")}` : label;
};

/** The pages a call names that a person can open: the conversation and the deal. */
function targetLink(target: Record<string, string>) {
  if (target.conversationId) return { href: `/inbox/${target.conversationId}`, label: "Conversation" };
  if (target.dealId) return { href: `/crm/deals/${target.dealId}`, label: "Deal" };
  return null;
}

/** What agents did in this organization, newest first. Owners and admins see it; reads are hidden until asked for. */
export function AgentActivity({ initial, retentionDays }: { initial: Page; retentionDays: number }) {
  const [page, setPage] = useState(initial);
  const [reads, setReads] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(withReads: boolean, before: string | null) {
    setLoading(true);
    setError(null);
    const query = new URLSearchParams();
    if (withReads) query.set("reads", "1");
    if (before) query.set("before", before);
    const result = await callApi<Page>(`/api/settings/mcp/activity?${query}`, "GET");
    setLoading(false);
    if (!result.ok || !result.data) return setError(result.error ?? "Could not load agent activity.");
    const next = result.data;
    setPage((current) => (before ? { calls: [...current.calls, ...next.calls], more: next.more } : next));
  }

  return (
    <SettingsSection
      id="activity"
      title="Agent activity"
      description={`Each call an agent made with a token of this organization, kept ${retentionDays} days. Changes show by default.`}
      action={
        <div className="flex items-center gap-2">
          <Checkbox
            id="activity-reads"
            checked={reads}
            disabled={loading}
            onCheckedChange={(checked) => {
              const next = checked === true;
              setReads(next);
              void load(next, null);
            }}
          />
          <Label htmlFor="activity-reads" className="text-sm font-normal">
            Show reads
          </Label>
        </div>
      }
    >
      {error && <p className="text-sm text-destructive">{error}</p>}
      {page.calls.length === 0 ? (
        <EmptyState className="py-0" title={reads ? "No agent calls yet" : "No agent changes yet"} />
      ) : (
        <ul className={RULED_LIST} aria-label="Agent activity">
          {page.calls.map((call) => {
            const link = targetLink(call.target);
            return (
              <li key={call.id} className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-sm ${RULED_ROW}`}>
                <span className="font-medium">{toolLabel(call)}</span>
                {call.errorCode && <Badge variant="outline">Refused: {call.errorCode.replaceAll("_", " ")}</Badge>}
                <span className="text-muted-foreground">
                  {call.userName}, {call.tokenName}
                  {call.clientName && ` in ${call.clientName}`}
                </span>
                {link && (
                  <Link href={link.href} className="underline underline-offset-2">
                    {link.label}
                  </Link>
                )}
                <Time value={call.createdAt} className="ml-auto text-muted-foreground" />
              </li>
            );
          })}
        </ul>
      )}
      {page.more && (
        <div>
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void load(reads, page.calls.at(-1)?.id ?? null)}>
            {loading ? "Loading…" : "Show older"}
          </Button>
        </div>
      )}
    </SettingsSection>
  );
}
