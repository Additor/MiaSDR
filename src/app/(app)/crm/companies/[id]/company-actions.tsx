"use client";

import { EllipsisIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ChoiceCard } from "@/components/shell/choice-card";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { RadioGroup } from "@/components/ui/radio-group";
import { runApiAction, type ActionOptions } from "@/app/_lib/api-action";
import { apiMessage, callApi } from "@/app/_lib/api-client";
import {
  MERGE_TIMEOUT,
  companyChangedText,
  companyLabel,
  deleteCompanyDescription,
  deletedCompanyText,
  keepOptionLabel,
  mergePreviewLines,
  mergedText,
  noMatchText,
  type MergePreview,
} from "./company-merge-copy";

/** The company as the page read it. `version` goes back with the delete; `contacts` and `leads` decide which delete dialog opens. */
export interface CompanyActionTarget {
  id: string;
  name: string | null;
  domain: string;
  version: number;
  contacts: number;
  leads: number;
}

/**
 * The company's rare actions: a ghost More menu with Merge with another company and Delete company, so neither stands
 * level with Create deal or Add contact. `inUseText` is the `company_in_use` sentence the server words for a company with people.
 */
export function CompanyActions({ company, inUseText }: { company: CompanyActionTarget; inUseText: string }) {
  const [dialog, setDialog] = useState<"merge" | "delete" | null>(null);
  const label = companyLabel(company);
  const onOpenChange = (open: boolean) => !open && setDialog(null);
  const inUse = company.contacts + company.leads > 0;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" aria-label={`More actions for ${label}`} />}>
          <EllipsisIcon aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-48">
          <DropdownMenuItem className="max-sm:min-h-11" onClick={() => setDialog("merge")}>
            Merge with another company
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" className="max-sm:min-h-11" onClick={() => setDialog("delete")}>
            Delete company
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <MergeDialog company={company} open={dialog === "merge"} onOpenChange={onOpenChange} />
      {inUse ? (
        <CompanyInUseDialog company={company} text={inUseText} open={dialog === "delete"} onOpenChange={onOpenChange} />
      ) : (
        <DeleteCompanyDialog company={company} open={dialog === "delete"} onOpenChange={onOpenChange} />
      )}
    </>
  );
}

const leadsHref = (domain: string) => `/leads?q=${encodeURIComponent(domain)}`;

interface SearchRow {
  companyId: string;
  name: string | null;
  domain: string;
  contacts: number;
  listed: boolean;
}

/** Gives up after a minute. A call that never answers has status 0, so the merge can say it may still run. */
const timeout = () => ({ signal: AbortSignal.timeout(60_000) });
const read = <T,>(url: string) => callApi<T>(url, "GET", undefined, timeout());
/** A change through `runApiAction`, with the same one-minute limit. */
const send = (url: string, method: "POST" | "DELETE", body?: unknown, options?: ActionOptions) => runApiAction(callApi(url, method, body, timeout()), options);

/**
 * Merge in two steps of one dialog. Step 1 finds the other company (companies with leads only included, marked "Leads only") and
 * asks which one to keep, the current one checked. Step 2 shows the preview; Back returns with the choice kept.
 */
function MergeDialog({ company, open, onOpenChange }: { company: CompanyActionTarget; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const id = useId();
  const [step, setStep] = useState<1 | 2>(1);
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState<string | null>(null);
  const [results, setResults] = useState<SearchRow[] | null>(null);
  const [picked, setPicked] = useState<SearchRow | null>(null);
  const [keepId, setKeepId] = useState(company.id);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  const firstLine = useRef<HTMLParagraphElement>(null);

  // Each open starts at step 1 with nothing picked.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setStep(1);
      setQuery("");
      setSearched(null);
      setResults(null);
      setPicked(null);
      setKeepId(company.id);
      setPreview(null);
      setStatus(null);
    }
  }

  useEffect(() => {
    if (step === 2 && preview) firstLine.current?.focus();
  }, [step, preview]);

  const label = companyLabel(company);
  const current: SearchRow = { companyId: company.id, name: company.name, domain: company.domain, contacts: company.contacts, listed: true };
  const pair = picked ? (keepId === company.id ? { kept: current, other: picked } : { kept: picked, other: current }) : null;

  async function search(event: FormEvent) {
    event.preventDefault();
    const q = query.trim();
    if (!q) return;
    setStatus(null);
    const answer = await read<{ companies: SearchRow[] }>(`/api/companies/search?q=${encodeURIComponent(q)}&all=1`);
    if (!answer.ok) return setStatus(answer.error ?? "Could not search companies. Try again.");
    const rows = (answer.data?.companies ?? []).filter((row) => row.companyId !== company.id);
    setResults(rows);
    setSearched(q);
    if (picked && !rows.some((row) => row.companyId === picked.companyId)) {
      setPicked(null);
      setKeepId(company.id);
    }
  }

  async function loadPreview(): Promise<boolean> {
    if (!pair) return false;
    // A read sent as POST: nothing changes, so nothing reloads.
    const answer = await runApiAction(callApi<MergePreview>(`/api/companies/${pair.kept.companyId}/merge/preview`, "POST", { otherId: pair.other.companyId }, timeout()), { expectData: true });
    if (!answer.ok) {
      setStatus(answer.error);
      return false;
    }
    setPreview(answer.data);
    return true;
  }

  async function toPreview(): Promise<false> {
    setStatus(null);
    if (await loadPreview()) setStep(2);
    return false;
  }

  async function merge(): Promise<false | void> {
    if (!preview) return false;
    setStatus(null);
    const kept = companyLabel(preview.kept);
    const other = companyLabel(preview.other);
    const answer = await send(`/api/companies/${preview.kept.id}/merge`, "POST", {
      otherId: preview.other.id,
      expected: { keptVersion: preview.kept.version, otherVersion: preview.other.version, keptPeople: preview.kept.people, otherPeople: preview.other.people },
    }, { onConflict: { try_again: () => apiMessage("try_again", kept) } });
    if (answer.ok) {
      toast.success(mergedText(other, kept));
      router.replace(`/crm/companies/${preview.kept.id}`);
      router.refresh();
      return;
    }
    if (answer.status === 0 || (answer.status >= 502 && answer.status <= 504)) {
      setStatus(MERGE_TIMEOUT);
      return false;
    }
    if (answer.code === "company_changed") {
      setStatus(answer.error);
      await loadPreview();
      return false;
    }
    setStatus(answer.error);
    return false;
  }

  const statusLine = status && (
    <p role="status" className="text-sm" data-testid="merge-status">
      {status}
    </p>
  );

  if (step === 2 && preview) {
    const lines = mergePreviewLines(preview);
    return (
      <ConfirmDialog
        open={open}
        onOpenChange={onOpenChange}
        title={`Merge ${label} with another company`}
        description=""
        confirmLabel="Merge companies"
        pendingLabel="Merging…"
        className="sm:max-w-md [&_[data-slot=dialog-description]:empty]:hidden"
        back={{
          label: "Back",
          onClick: () => {
            setStatus(null);
            setStep(1);
          },
        }}
        onConfirm={merge}
      >
        {statusLine}
        <div className="grid gap-2 text-sm" data-testid="merge-preview">
          {lines.map((line, index) => (
            <p key={line} ref={index === 0 ? firstLine : undefined} tabIndex={index === 0 ? -1 : undefined} className={index === 0 ? "font-medium outline-none" : index === lines.length - 1 ? "font-medium" : "text-muted-foreground"}>
              {line}
            </p>
          ))}
        </div>
      </ConfirmDialog>
    );
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Merge ${label} with another company`}
      description=""
      confirmLabel="Preview merge"
      pendingLabel="Checking…"
      confirmDisabled={!pair}
      className="sm:max-w-md [&_[data-slot=dialog-description]:empty]:hidden"
      onConfirm={toPreview}
    >
      <form onSubmit={search} className="flex flex-wrap items-end gap-2" data-testid="merge-search">
        <Field className="min-w-0 flex-1">
          <FieldLabel htmlFor={`${id}-q`}>Company to merge</FieldLabel>
          <Input id={`${id}-q`} value={query} autoFocus autoComplete="off" placeholder="Search companies by name or domain" touch onChange={(e) => setQuery(e.target.value)} />
        </Field>
        <Button type="submit" variant="outline" disabled={query.trim() === ""} touch>
          Search
        </Button>
      </form>
      {statusLine}
      {results && results.length === 0 && searched && <p className="text-sm text-muted-foreground">{noMatchText(searched)}</p>}
      {results && results.length > 0 && (
        <RadioGroup
          aria-label="Matching companies"
          value={picked?.companyId ?? ""}
          onValueChange={(value) => {
            const row = results.find((r) => r.companyId === value);
            if (!row) return;
            setPicked(row);
            setKeepId(company.id);
          }}
          className="gap-1"
        >
          {results.map((row) => (
            <ChoiceCard key={row.companyId} id={`${id}-other-${row.companyId}`} value={row.companyId} trailing={!row.listed && <Badge variant="outline">Leads only</Badge>}>
              {companyLabel(row)} <span className="text-muted-foreground">({row.domain})</span>
            </ChoiceCard>
          ))}
        </RadioGroup>
      )}
      {picked && (
        <FieldSet data-testid="merge-keep">
          <FieldLegend variant="label">Company to keep</FieldLegend>
          <RadioGroup value={keepId} onValueChange={(value) => setKeepId(value as string)} className="gap-1">
            {[current, picked].map((row) => (
              <ChoiceCard key={row.companyId} id={`${id}-keep-${row.companyId}`} value={row.companyId}>
                {keepOptionLabel(row)}
              </ChoiceCard>
            ))}
          </RadioGroup>
        </FieldSet>
      )}
    </ConfirmDialog>
  );
}

/** A company that people still point at: the reason and the way to its leads, and no confirm. */
function CompanyInUseDialog({ company, text, open, onOpenChange }: { company: CompanyActionTarget; text: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`Delete ${companyLabel(company)}?`}</DialogTitle>
          <DialogDescription>{text}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Link href={leadsHref(company.domain)} className={buttonVariants({ variant: "outline" })}>
            Find its leads
          </Link>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteCompanyDialog({ company, open, onOpenChange }: { company: CompanyActionTarget; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  const label = companyLabel(company);

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setStatus(null);
  }

  async function remove(): Promise<false | void> {
    setStatus(null);
    // A success leaves the page; a changed company reloads it to read the new version and people counts.
    const answer = await send(`/api/companies/${company.id}?expectedVersion=${company.version}`, "DELETE", undefined, {
      onConflict: {
        company_changed: () => {
          router.refresh();
          return companyChangedText(label);
        },
      },
    });
    if (!answer.ok && answer.status === 0) throw new Error(answer.error);
    if (answer.ok) {
      toast.success(deletedCompanyText(label));
      router.replace("/crm/companies");
      router.refresh();
      return;
    }
    setStatus(answer.error);
    return false;
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete ${label}?`}
      description={deleteCompanyDescription(label, company.domain)}
      confirmLabel="Delete company"
      cancelLabel="Keep company"
      pendingLabel="Deleting…"
      destructive
      onConfirm={remove}
    >
      {status && (
        <p role="status" className="text-sm" data-testid="company-delete-status">
          {status}
        </p>
      )}
    </ConfirmDialog>
  );
}
