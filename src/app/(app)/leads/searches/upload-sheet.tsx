"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface UploadSheetConfig {
  accounts: Array<{ id: string; name: string }>;
  maxRows: number;
  defaultMaxResults: number;
  maxResultsLimit: number;
}

interface UploadReport {
  id: string;
  queued: number;
  duplicatesInFile: number;
  alreadyQueued: number;
  rejectedCount: number;
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
    const response = await fetch("/api/linkedin/search-batches", { method: "POST", body });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      // The refusal and its reasons render in the body, and the dialog stays open.
      setError(data.error ?? "The upload failed. Check the file and try again.");
      setIssues(Array.isArray(data.issues) ? data.issues.map((i: { message: string }) => i.message) : []);
      return false;
    }
    const report = data as UploadReport;
    setCampaign(NO_CAMPAIGN);
    setAccountIds([]);
    const skipped = [report.rejectedCount && `${report.rejectedCount} refused`, report.duplicatesInFile && `${report.duplicatesInFile} repeated`, report.alreadyQueued && `${report.alreadyQueued} already queued`].filter(Boolean);
    toast.success(`${report.queued.toLocaleString("en-US")} ${report.queued === 1 ? "search" : "searches"} queued${skipped.length ? `, ${skipped.join(", ")}` : ""}.`);
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
      <Button variant={variant} className="max-sm:h-11 max-sm:px-4" onClick={() => setOpen(true)}>
        Upload sheet
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={onOpenChange}
        title="Upload search batch"
        description={`A CSV or XLSX file of up to ${config.maxRows.toLocaleString("en-US")} rows with a search_url column and an optional company_name column.`}
        confirmLabel="Queue searches"
        pendingLabel="Uploading…"
        onConfirm={upload}
      >
        <form ref={form} onSubmit={(e) => e.preventDefault()} className="stack-group">
          <p className="text-sm">
            <a href="/api/linkedin/search-batches/template" download className="underline underline-offset-4">
              Download the template
            </a>
          </p>
          <div className="stack-field">
            <Label htmlFor="batch-name">Name</Label>
            <Input id="batch-name" name="name" placeholder="Berlin fintech CTOs" required maxLength={120} autoFocus />
          </div>
          <div className="stack-field">
            <Label htmlFor="batch-file">File</Label>
            <Input id="batch-file" name="file" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required />
          </div>
          <div className="stack-field">
            <Label htmlFor="batch-max">Stop each search after</Label>
            <Input id="batch-max" name="maxResults" type="number" min={1} max={config.maxResultsLimit} defaultValue={config.defaultMaxResults} required />
            <p className="text-xs text-muted-foreground">People per search, up to {config.maxResultsLimit.toLocaleString("en-US")}.</p>
          </div>
          <div className="stack-field">
            <Label htmlFor="batch-campaign">Add to campaign</Label>
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
          </div>
          {config.accounts.length > 1 && (
            <fieldset className="grid gap-1">
              <legend className="mb-1 text-sm font-medium">LinkedIn accounts</legend>
              {config.accounts.map((a) => (
                <label key={a.id} className="flex min-h-8 items-center gap-2 text-sm max-sm:min-h-11">
                  <Checkbox checked={accountIds.includes(a.id)} onCheckedChange={(on) => setAccountIds((cur) => (on === true ? [...cur, a.id] : cur.filter((id) => id !== a.id)))} />
                  {a.name}
                </label>
              ))}
              <p className="text-xs text-muted-foreground">Leave all unchecked to let any connected account search.</p>
            </fieldset>
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
        </form>
      </ConfirmDialog>
    </>
  );
}
