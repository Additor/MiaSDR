"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CAMPAIGN_FIELDS, type CampaignField } from "@/contexts/grid/domain/campaign-rows";
import { acceptsEnrollments } from "@/contexts/outreach/domain/campaign";
import { guessFields } from "../_lib/data/push-guess";
import { gridRequest, gridUrl } from "../_lib/data/client";
import type { GridColumn } from "../_lib/data/types";
import { ColumnChoice, Choice, ErrorText, Field } from "./form-bits";

interface Campaign {
  id: string;
  name: string;
  status: string;
}

interface Report {
  campaignId: string;
  channel: "email" | "linkedin";
  created: boolean;
  enrolled: number;
  leadsCreated: number;
  leadsUpdated: number;
  failures: Array<{ rowId: string; reason: string }>;
}

const FIELD_LABELS: Record<CampaignField, string> = {
  email: "Email",
  linkedin: "LinkedIn URL",
  firstName: "First name",
  lastName: "Last name",
  fullName: "Full name",
  title: "Job title",
  phone: "Phone",
  companyName: "Company name",
  companyDomain: "Company domain",
};

const NEW = "__new__";
interface Props {
  tableId: string;
  columns: GridColumn[];
  rowIds: string[];
  /** Row number by id for the rows that are loaded, to label skipped rows. */
  rowNumbers: Map<string, number>;
  onClose: () => void;
}

/** Sends the chosen rows to a campaign as leads and enrollments. Nothing is sent: the campaign keeps its status. */
export function PushCampaignDialog({ tableId, columns, rowIds, rowNumbers, onClose }: Props) {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [target, setTarget] = useState<string>(NEW);
  const [newName, setNewName] = useState("");
  const [fields, setFields] = useState<Partial<Record<CampaignField, string | null>>>(() => guessFields(CAMPAIGN_FIELDS, columns));
  const [custom, setCustom] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);

  useEffect(() => {
    let cancelled = false;
    void gridRequest<Campaign[]>("/api/campaigns", "GET").then((res) => {
      if (cancelled) return;
      const list = res.ok && Array.isArray(res.data) ? res.data : [];
      setCampaigns(list.filter(acceptsEnrollments));
      if (!res.ok) setError(res.error);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const mapped = useMemo(() => Object.fromEntries(Object.entries(fields).filter((e): e is [string, string] => !!e[1])), [fields]);
  const hasAddress = !!mapped.email || !!mapped.linkedin;
  const usedKeys = new Set(Object.values(mapped));
  const customOptions = columns.filter((c) => !usedKeys.has(c.key));
  const nameOk = target !== NEW || newName.trim().length > 0;

  async function push() {
    setBusy(true);
    setError(null);
    const res = await gridRequest<Report>(gridUrl.sub(tableId, "campaigns"), "POST", {
      rowIds,
      fields: mapped,
      customColumnKeys: custom.filter((k) => !usedKeys.has(k)),
      ...(target === NEW ? { newCampaignName: newName.trim() } : { campaignId: target }),
    });
    setBusy(false);
    if (!res.ok || !res.data) return setError(res.error);
    setReport(res.data);
  }

  const campaignItems = [{ value: NEW, label: "New draft campaign" }, ...(campaigns ?? []).map((c) => ({ value: c.id, label: `${c.name} (${c.status})` }))];

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Push to campaign</DialogTitle>
          <DialogDescription>
            {rowIds.length.toLocaleString("en-US")} row{rowIds.length === 1 ? "" : "s"} become leads and are enrolled. Nothing is sent now: the campaign keeps its status, and every message still waits for approval.
          </DialogDescription>
        </DialogHeader>

        {report ? (
          <div className="grid gap-4" aria-live="polite">
            <p className="text-sm">
              {report.created ? "Created a draft campaign. " : ""}Enrolled <strong>{report.enrolled}</strong> of {rowIds.length}. Leads created {report.leadsCreated}, updated {report.leadsUpdated}.
            </p>
            {report.failures.length > 0 && (
              <div>
                <h3 className="mb-1 text-sm font-medium">Skipped ({report.failures.length})</h3>
                <ul className="max-h-60 overflow-auto rounded-lg border text-sm">
                  {report.failures.map((f) => (
                    <li key={f.rowId} className="flex gap-3 border-b px-3 py-1.5 last:border-b-0">
                      <span className="w-16 shrink-0 text-muted-foreground tabular-nums">{rowNumbers.has(f.rowId) ? `Row ${rowNumbers.get(f.rowId)}` : f.rowId.slice(0, 6)}</span>
                      <span>{f.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <DialogFooter>
              <Link href={`/campaigns/${report.campaignId}`} className={buttonVariants({ variant: "outline" })}>
                Open campaign
              </Link>
              <Button type="button" onClick={onClose}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <div className="grid gap-4">
              <Field label="Campaign" htmlFor="push-target">
                <Choice id="push-target" items={campaignItems} value={target} onChange={setTarget} />
              </Field>
              {target === NEW && (
                <Field label="New campaign name" htmlFor="push-name">
                  <Input id="push-name" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={120} />
                </Field>
              )}
              <fieldset className="grid gap-2">
                <legend className="mb-1 text-sm font-medium">Lead fields</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {CAMPAIGN_FIELDS.map((f) => (
                    <Field key={f} label={FIELD_LABELS[f]} htmlFor={`push-f-${f}`}>
                      <ColumnChoice id={`push-f-${f}`} value={fields[f] ?? null} none="Not mapped" onChange={(k) => setFields((s) => ({ ...s, [f]: k }))} columns={columns} />
                    </Field>
                  ))}
                </div>
                {!hasAddress && <p className="text-xs text-destructive">Map an email or a LinkedIn URL. Rows without one are skipped.</p>}
              </fieldset>
              {customOptions.length > 0 && (
                <fieldset className="stack-field">
                  <legend className="mb-1 text-sm font-medium">Keep as custom fields (up to 20)</legend>
                  <div className="grid max-h-36 gap-1 overflow-auto sm:grid-cols-2">
                    {customOptions.map((c) => (
                      <label key={c.id} className="flex items-center gap-2 text-sm">
                        <Checkbox checked={custom.includes(c.key)} disabled={!custom.includes(c.key) && custom.length >= 20} onCheckedChange={(v) => setCustom((s) => (v === true ? [...s, c.key] : s.filter((k) => k !== c.key)))} />
                        {c.name}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
              <ErrorText>{error}</ErrorText>
              {campaigns?.some((c) => c.status === "active") && target !== NEW && campaigns.find((c) => c.id === target)?.status === "active" && (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline">active</Badge> This campaign is live. New enrollments follow its approval rules.
                </p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button type="button" onClick={push} disabled={busy || !hasAddress || !nameOk || rowIds.length === 0 || campaigns === null}>
                {busy ? "Pushing..." : `Push ${rowIds.length.toLocaleString("en-US")} ${rowIds.length === 1 ? "row" : "rows"}`}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
