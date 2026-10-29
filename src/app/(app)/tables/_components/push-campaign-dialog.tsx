"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CampaignStatusToken } from "@/app/(app)/campaigns/[id]/_components/campaign-status-token";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { SectionHead } from "@/components/shell/section";
import { buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { campaignStatusLabel } from "@/contexts/outreach/domain/campaign-view";
import { countOf, formatCount } from "@/shared/format-number";
import { CAMPAIGN_FIELDS, type CampaignField } from "@/contexts/grid/domain/campaign-rows";
import { VERDICT_LABELS, verifyColumns, type PassableVerdict, type PushVerdict } from "@/contexts/grid/domain/verified-push";
import { acceptsEnrollments } from "@/contexts/outreach/domain/campaign";
import { guessFields } from "../_lib/data/push-guess";
import { gridRequest, gridUrl } from "../_lib/data/client";
import type { GridColumn } from "../_lib/data/types";
import { ColumnSelect, ItemSelect } from "./form-bits";

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
  /** True when no row was selected, so the push covers every row the view shows. */
  allRows?: boolean;
  onClose: () => void;
}

/** Sends the chosen rows to a campaign as leads and enrollments. Nothing is sent: the campaign keeps its status. */
/** "2 Valid, 1 Catch-all" from verdict counts, in the order the verdicts are listed. */
function verdictList(counts: Partial<Record<PushVerdict, number>>, only: (v: PushVerdict) => boolean): string {
  return (Object.keys(VERDICT_LABELS) as PushVerdict[])
    .filter((v) => only(v) && (counts[v] ?? 0) > 0)
    .map((v) => `${counts[v]} ${VERDICT_LABELS[v]}`)
    .join(", ");
}

export function PushCampaignDialog({ tableId, columns, rowIds, rowNumbers, allRows, onClose }: Props) {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [target, setTarget] = useState<string>(NEW);
  const [newName, setNewName] = useState("");
  const [fields, setFields] = useState<Partial<Record<CampaignField, string | null>>>(() => guessFields(CAMPAIGN_FIELDS, columns));
  const [custom, setCustom] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  // A table that verified its addresses pushes only the ones it found valid, unless the person says otherwise.
  const checks = useMemo(() => verifyColumns(columns), [columns]);
  const [gateOn, setGateOn] = useState(checks.length > 0);
  const [allowCatchAll, setAllowCatchAll] = useState(false);
  const [counts, setCounts] = useState<{ columnKey: string; verdicts: Partial<Record<PushVerdict, number>> } | null>(null);

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
  const check = checks.find((c) => c.emailColumnKey && c.emailColumnKey === mapped.email) ?? checks[0];
  const checkMatches = !!check && check.emailColumnKey === mapped.email;
  const gated = gateOn && checkMatches;
  const allow: PassableVerdict[] = allowCatchAll ? ["valid", "catch_all"] : ["valid"];
  const verdicts = counts && check && counts.columnKey === check.key ? counts.verdicts : null;
  const passing = verdicts ? allow.reduce((sum, v) => sum + (verdicts[v] ?? 0), 0) : null;

  // The verdict counts of the rows being pushed, for the line under the check.
  useEffect(() => {
    if (!check) return;
    let cancelled = false;
    void gridRequest<{ verdicts: Partial<Record<PushVerdict, number>> }>(gridUrl.sub(tableId, "campaigns"), "POST", { rowIds, preview: true, verifiedBy: { columnKey: check.key }, emailKey: mapped.email }).then((res) => {
      if (!cancelled && res.ok && res.data) setCounts({ columnKey: check.key, verdicts: res.data.verdicts });
    });
    return () => {
      cancelled = true;
    };
  }, [check, rowIds, tableId, mapped.email]);
  const hasAddress = !!mapped.email || !!mapped.linkedin;
  const usedKeys = new Set(Object.values(mapped));
  const customOptions = columns.filter((c) => !usedKeys.has(c.key));
  const nameOk = target !== NEW || newName.trim().length > 0;

  // The report stays in the dialog, so the promise resolves to false and keeps it open.
  async function push() {
    const res = await gridRequest<Report>(gridUrl.sub(tableId, "campaigns"), "POST", {
      rowIds,
      fields: mapped,
      customColumnKeys: custom.filter((k) => !usedKeys.has(k)),
      ...(gated && check ? { verifiedBy: { columnKey: check.key, allow } } : {}),
      ...(target === NEW ? { newCampaignName: newName.trim() } : { campaignId: target }),
    });
    if (!res.ok || !res.data) throw new Error(res.error ?? "Could not push the rows.");
    setReport(res.data);
    return false;
  }

  const campaignItems = [{ value: NEW, label: "New draft campaign" }, ...(campaigns ?? []).map((c) => ({ value: c.id, label: `${c.name} (${campaignStatusLabel(c.status)})` }))];

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Push to campaign"
      description={`${allRows ? `No rows are selected, so all ${formatCount(rowIds.length)} rows in this view are pushed.` : `${countOf(rowIds.length, "selected row")}.`} They become leads and are enrolled. Nothing is sent now: the campaign keeps its status, and every message still waits for approval.`}
      confirmLabel={gated && passing !== null ? `Push ${formatCount(passing)} of ${formatCount(rowIds.length)} rows` : `Push ${countOf(rowIds.length, "row")}`}
      cancelLabel={report ? "Done" : "Cancel"}
      pendingLabel="Pushing…"
      confirmDisabled={report !== null || !hasAddress || !nameOk || rowIds.length === 0 || campaigns === null || (gateOn && !!check && !checkMatches) || (gated && passing === 0)}
      className="sm:max-w-2xl"
      onConfirm={push}
    >
      {report ? (
        <div role="status" className="grid gap-4">
          <p className="text-sm">
            {report.created ? "Created a draft campaign. " : ""}Enrolled <strong>{formatCount(report.enrolled)}</strong> of {formatCount(rowIds.length)}. Leads created {formatCount(report.leadsCreated)}, updated {formatCount(report.leadsUpdated)}.
            {gated ? ` Rows the verification kept out are listed under Skipped.` : ""}
          </p>
          {report.failures.length > 0 && (
            <div className="stack-group">
              <SectionHead level="h3" title="Skipped" count={formatCount(report.failures.length)} />
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
          <div>
            <Link href={`/campaigns/${report.campaignId}`} className={buttonVariants({ variant: "outline" })}>
              Open campaign
            </Link>
          </div>
        </div>
      ) : (
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="push-target">Campaign</FieldLabel>
            <ItemSelect id="push-target" items={campaignItems} value={target} onChange={setTarget} />
          </Field>
          {target === NEW && (
            <Field>
              <FieldLabel htmlFor="push-name">New campaign name</FieldLabel>
              <Input id="push-name" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={120} />
            </Field>
          )}
          <FieldSet>
            <FieldLegend variant="label">Lead fields</FieldLegend>
            <div className="grid gap-group sm:grid-cols-2">
              {CAMPAIGN_FIELDS.map((f) => (
                <Field key={f}>
                  <FieldLabel htmlFor={`push-f-${f}`}>{FIELD_LABELS[f]}</FieldLabel>
                  <ColumnSelect id={`push-f-${f}`} value={fields[f] ?? null} none="Not mapped" onChange={(k) => setFields((s) => ({ ...s, [f]: k }))} columns={columns} />
                </Field>
              ))}
            </div>
            {!hasAddress && <p className="text-xs text-destructive">Map an email or a LinkedIn URL. Rows without one are skipped.</p>}
          </FieldSet>
          {check && (
            <FieldSet>
              <FieldLegend variant="label">Verification</FieldLegend>
              <Field orientation="horizontal">
                <Checkbox id="push-gate" checked={gateOn} onCheckedChange={(v) => setGateOn(v === true)} />
                <FieldLabel htmlFor="push-gate">Only push addresses {check.name} marked Valid</FieldLabel>
              </Field>
              {gateOn && (
                <Field orientation="horizontal" className="pl-6">
                  <Checkbox id="push-catch-all" checked={allowCatchAll} onCheckedChange={(v) => setAllowCatchAll(v === true)} />
                  <FieldLabel htmlFor="push-catch-all">Also push Catch-all addresses (the domain accepts any address, so delivery is not confirmed)</FieldLabel>
                </Field>
              )}
              {gateOn && !checkMatches && (
                <p className="text-sm text-destructive">
                  {check.name} checked {columns.find((c) => c.key === check.emailColumnKey)?.name ?? "another column"}, not the Email mapped above. Map that column as Email to use the check.
                </p>
              )}
              {verdicts && (
                <p className="text-sm text-muted-foreground tabular-nums">
                  {gated ? `${formatCount(passing ?? 0)} of ${formatCount(rowIds.length)} rows pass (${verdictList(verdicts, (v) => (allow as string[]).includes(v)) || "none"}).` : `Verdicts: ${verdictList(verdicts, () => true)}.`}
                  {gated && verdictList(verdicts, (v) => !(allow as string[]).includes(v)) ? ` Kept out: ${verdictList(verdicts, (v) => !(allow as string[]).includes(v))}.` : ""}
                  {!gateOn && (verdicts.invalid ?? 0) > 0 ? " Invalid addresses will bounce and hurt your mailbox's reputation." : ""}
                </p>
              )}
            </FieldSet>
          )}
          {customOptions.length > 0 && (
            <FieldSet>
              <FieldLegend variant="label">Keep as custom fields (up to 20)</FieldLegend>
              <div className="grid max-h-36 gap-1 overflow-auto sm:grid-cols-2">
                {customOptions.map((c) => (
                  <Field key={c.id} orientation="horizontal">
                    <Checkbox
                      id={`push-custom-${c.id}`}
                      checked={custom.includes(c.key)}
                      disabled={!custom.includes(c.key) && custom.length >= 20}
                      onCheckedChange={(v) => setCustom((s) => (v === true ? [...s, c.key] : s.filter((k) => k !== c.key)))}
                    />
                    <FieldLabel htmlFor={`push-custom-${c.id}`} className="font-normal">
                      {c.name}
                    </FieldLabel>
                  </Field>
                ))}
              </div>
            </FieldSet>
          )}
          <FieldError>{error}</FieldError>
          {campaigns?.some((c) => c.status === "active") && target !== NEW && campaigns.find((c) => c.id === target)?.status === "active" && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <CampaignStatusToken status="active" compact /> This campaign is live. New enrollments follow its approval rules.
            </p>
          )}
        </FieldGroup>
      )}
    </ConfirmDialog>
  );
}
