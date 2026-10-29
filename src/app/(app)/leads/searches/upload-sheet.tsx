"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { countOf, formatCount } from "@/shared/format-number";
import type { UploadBatchReport } from "@/contexts/outreach/linkedin/application/linkedin-search-batch";
import { callApi } from "@/app/_lib/api-client";

export interface UploadSheetConfig {
  accounts: Array<{ id: string; name: string }>;
  maxRows: number;
  defaultMaxResults: number;
  maxResultsLimit: number;
}

const NO_CAMPAIGN = "none";

/** "Upload sheet": one dialog for the searches page and the batches page. A queued sheet opens its batch. */
export function UploadSheet({ config, campaigns, variant = "default" }: { config: UploadSheetConfig; campaigns: Array<{ id: string; name: string }>; variant?: "default" | "outline" }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const form = useRef<HTMLFormElement>(null);
  const [campaign, setCampaign] = useState(NO_CAMPAIGN);
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const items = [{ value: NO_CAMPAIGN, label: "No campaign (leads only)" }, ...campaigns.map((c) => ({ value: c.id, label: c.name }))];

  async function upload(): Promise<boolean> {
    // The confirm button sits outside the form, so it asks the form to check its own fields.
    if (!form.current?.reportValidity()) return false;
    const body = new FormData(form.current);
    body.set("campaignId", campaign === NO_CAMPAIGN ? "" : campaign);
    if (accountIds.length > 0) body.set("accountIds", JSON.stringify(accountIds));
    setError(null);
    setIssues([]);
    const result = await callApi<UploadBatchReport>("/api/linkedin/search-batches", "POST", body);
    if (!result.ok || !result.data) {
      // The refusal and its reasons render in the body, and the dialog stays open.
      setError(result.error ?? "The upload failed. Check the file and try again.");
      setIssues(result.issues.map((i) => i.message));
      return false;
    }
    const report = result.data;
    setCampaign(NO_CAMPAIGN);
    setAccountIds([]);
    const skipped = [report.rejectedCount && `${report.rejectedCount} refused`, report.duplicatesInFile && `${report.duplicatesInFile} repeated`, report.alreadyQueued && `${report.alreadyQueued} already queued`].filter(Boolean);
    toast.success(`${countOf(report.queued, "search", "searches")} queued${skipped.length ? `, ${skipped.join(", ")}` : ""}.`);
    router.push(`/leads/searches/batches/${report.id}`);
    return true;
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setError(null);
      setIssues([]);
    }
  }

  return (
    <>
      <Button variant={variant} touch onClick={() => setOpen(true)}>
        Upload sheet
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={onOpenChange}
        title="Upload search batch"
        description={`A CSV or XLSX file of up to ${formatCount(config.maxRows)} rows with a search_url column and an optional company_name column.`}
        confirmLabel="Queue searches"
        pendingLabel="Uploading…"
        onConfirm={upload}
      >
        <form ref={form} onSubmit={(e) => e.preventDefault()}>
          <FieldGroup>
          <p className="text-sm">
            <a href="/api/linkedin/search-batches/template" download className="rounded-sm underline underline-offset-4 focus-ring">
              Download the template
            </a>
          </p>
          <Field>
            <FieldLabel htmlFor="batch-name">Name</FieldLabel>
            <Input id="batch-name" name="name" placeholder="Berlin fintech CTOs" required maxLength={120} autoFocus />
          </Field>
          <Field>
            <FieldLabel htmlFor="batch-file">File</FieldLabel>
            <Input id="batch-file" name="file" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required />
          </Field>
          <Field>
            <FieldLabel htmlFor="batch-max">Stop each search after</FieldLabel>
            <Input id="batch-max" name="maxResults" type="number" min={1} max={config.maxResultsLimit} defaultValue={config.defaultMaxResults} required aria-describedby="batch-max-help" />
            <FieldDescription id="batch-max-help">People per search, up to {formatCount(config.maxResultsLimit)}.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="batch-campaign">Add to campaign</FieldLabel>
            <Select items={items} value={campaign} onValueChange={(v) => v && setCampaign(v)}>
              <SelectTrigger id="batch-campaign" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {items.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {config.accounts.length > 1 && (
            <FieldSet>
              <FieldLegend variant="label">LinkedIn accounts</FieldLegend>
              <FieldDescription>Leave all unchecked to let any connected account search.</FieldDescription>
              <FieldGroup className="gap-0">
                {config.accounts.map((a) => (
                  <Field key={a.id} orientation="horizontal" className="min-h-8 max-sm:min-h-11">
                    <Checkbox id={`batch-account-${a.id}`} checked={accountIds.includes(a.id)} onCheckedChange={(on) => setAccountIds((cur) => (on === true ? [...cur, a.id] : cur.filter((id) => id !== a.id)))} />
                    <FieldLabel htmlFor={`batch-account-${a.id}`} className="font-normal">
                      {a.name}
                    </FieldLabel>
                  </Field>
                ))}
              </FieldGroup>
            </FieldSet>
          )}
          {error && (
            <div role="alert" className="text-sm text-destructive">
              <p>{error}</p>
              {issues.length > 0 && (
                <ul className="mt-1 list-disc pl-5">
                  {issues.slice(0, 10).map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          </FieldGroup>
        </form>
      </ConfirmDialog>
    </>
  );
}
