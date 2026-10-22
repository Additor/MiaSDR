"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ChangeEvent, type Ref } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CUSTOM_LABEL_MAX, describeCustomLabels } from "@/contexts/people/domain/custom-fields";
import { confirmLabel, RESULT_EXAMPLES, summaryChangesAnything, type ImportSummary, type SkipGroup } from "@/contexts/people/domain/import-summary";
import { cn } from "@/lib/utils";
import { TARGETS, TARGET_GROUPS, customLabelOf, describeCustom, mappingError, selectValue, type Mapping } from "./mapping";
import { useMinWidth } from "./use-min-width";

interface Preview {
  headers: string[];
  totalRows: number;
  /** Up to three distinct non-empty values per column. */
  examples: Record<string, string[]>;
}
interface Issue {
  row: number;
  reason: string;
}
interface Report {
  /** Names the import. New leads carry `import:<runId>` as their source, which the lead list filters on. */
  runId?: string;
  stats: Record<string, number>;
  issues: { invalid: Issue[]; conflicts: Issue[]; duplicates: Issue[]; warnings: Issue[] };
}

type Busy = "reading" | "checking" | "importing" | null;

const count = (n: number) => n.toLocaleString("en-US");
const NETWORK_ERROR = "MiaSDR could not be reached. Check your connection and try again.";

const SKIP_LABELS: Record<SkipGroup["kind"], string> = {
  invalid_email: "Skipped, the email is not valid",
  missing_identifier: "Skipped, no email or LinkedIn profile",
  file_conflict: "Skipped, email and LinkedIn match different rows of the file",
  conflict: "Skipped, email and LinkedIn match different leads",
};

export function ImportWizard() {
  const fileRef = useRef<HTMLInputElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const wide = useMinWidth(640);
  const [step, setStep] = useState<1 | 2>(1);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [country, setCountry] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [report, setReport] = useState<Report | null>(null);

  // The summary is the point of the review step, so keyboard and screen reader users land on it.
  useEffect(() => {
    if (summary) summaryRef.current?.focus();
  }, [summary]);

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0] ?? null;
    setFile(chosen);
    setPreview(null);
    setSummary(null);
    setReport(null);
    setError(null);
    setStep(1);
    if (!chosen) return;
    setBusy("reading");
    const body = new FormData();
    body.set("file", chosen);
    try {
      const response = await fetch("/api/leads/import/preview", { method: "POST", body });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error ?? "The file could not be read.");
        return;
      }
      setPreview(data);
      setMapping(data.suggestedMapping);
      setStep(2);
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setBusy(null);
    }
  }

  /** A change to the mapping or the country makes the last summary wrong, so it goes. */
  function edit(change: (current: Mapping) => Mapping) {
    setSummary(null);
    setMapping(change);
  }

  function setTarget(header: string, value: string | null) {
    edit((current) => ({ ...current, [header]: value === "custom" ? `custom:${header.trim().slice(0, CUSTOM_LABEL_MAX)}` : (value ?? "skip") }));
  }

  function setLabel(header: string, label: string) {
    edit((current) => ({ ...current, [header]: `custom:${label}` }));
  }

  function importBody() {
    const body = new FormData();
    body.set("file", file!);
    body.set("mapping", JSON.stringify(mapping));
    body.set("defaultCountry", country);
    return body;
  }

  async function review() {
    if (!file || !preview) return;
    setBusy("checking");
    setError(null);
    try {
      const response = await fetch("/api/leads/import/summary", { method: "POST", body: importBody() });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error ?? "The file could not be checked.");
        return;
      }
      setSummary(data);
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setBusy(null);
    }
  }

  async function runImport() {
    if (!file || !preview) return;
    setBusy("importing");
    setError(null);
    try {
      const response = await fetch("/api/leads/import", { method: "POST", body: importBody() });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error ?? "The import failed.");
        return;
      }
      setReport(data);
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setBusy(null);
    }
  }

  function reset() {
    setFile(null);
    setPreview(null);
    setMapping({});
    setCountry("");
    setBusy(null);
    setSummary(null);
    setReport(null);
    setError(null);
    setStep(1);
    if (fileRef.current) fileRef.current.value = "";
  }

  if (report) return <Result report={report} onReset={reset} />;

  const blocking = preview ? mappingError(preview.headers, mapping) : null;
  const customInfo = preview ? describeCustom(preview.headers, mapping) : new Map<string, ReturnType<typeof describeCustomLabels>[number]>();
  const touch = wide ? "" : "h-11";
  const buttonClass = "max-sm:h-11 max-sm:flex-1";

  return (
    <div className="stack-section max-w-4xl">
      {step === 1 && (
        <section className="stack-group">
          <div className="stack-field">
            <h2 className="text-base font-semibold">1. Choose a file</h2>
            <p className="text-sm text-muted-foreground">
              Use a CSV or Excel (.xlsx) file with column names in the first row. Each lead needs an email or a LinkedIn profile. The limit is 5 MB and 10,000 rows. CSV files can separate values with commas, semicolons or tabs. MiaSDR reads the first sheet of an Excel file and refuses files with macros.
            </p>
          </div>
          <div className="stack-group">
            <div>
              <a href="/api/leads/import/sample" download className={cn(buttonVariants({ variant: "outline" }), "max-sm:h-11")}>
                Download sample CSV
              </a>
            </div>
            <Input
              ref={fileRef}
              type="file"
              aria-label="Choose a CSV or XLSX file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={onFile}
              disabled={busy !== null}
              className={cn("max-sm:h-11 max-sm:file:h-8")}
            />
            {busy === "reading" && (
              <p role="status" className="text-sm text-muted-foreground">
                Reading the file…
              </p>
            )}
            {preview && file && (
              <p className="text-sm">
                <span className="font-medium break-all">{file.name}</span>
                <span className="text-muted-foreground">: {count(preview.totalRows)} {preview.totalRows === 1 ? "row" : "rows"}, {count(preview.headers.length)} {preview.headers.length === 1 ? "column" : "columns"}.</span>
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/leads" className={cn(buttonVariants({ variant: "ghost" }), buttonClass)}>
              Cancel
            </Link>
            <Button className={buttonClass} onClick={() => setStep(2)} disabled={!preview || busy !== null}>
              Continue
            </Button>
          </div>
        </section>
      )}

      {step === 2 && preview && (
        <section className="stack-group">
          <div className="stack-field">
            <h2 className="text-base font-semibold">2. Match columns</h2>
            <p className="text-sm text-muted-foreground">
              {count(preview.totalRows)} {preview.totalRows === 1 ? "row" : "rows"} found. Each lead needs an email or a LinkedIn profile. A full name column fills first and last name when the file has none. Columns MiaSDR does not recognize become custom fields you can use in campaigns. Choose &quot;Keep in source data only&quot; to store a column without a field.
            </p>
          </div>
          <div className="stack-group">
            {wide ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Column in your file</TableHead>
                    <TableHead>Examples</TableHead>
                    <TableHead>Import as</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.headers.map((header) => (
                    <TableRow key={header}>
                      <TableCell className="max-w-56 align-top font-medium break-words whitespace-normal">{header}</TableCell>
                      <TableCell className="max-w-64 align-top">
                        <Examples values={preview.examples[header] ?? []} />
                      </TableCell>
                      <TableCell className="align-top">
                        <TargetSelect header={header} mapping={mapping} onTarget={setTarget} className="w-60" />
                        {customInfo.has(header) && (
                          <CustomField header={header} label={customLabelOf(mapping[header])} info={customInfo.get(header)!} onLabel={(label) => setLabel(header, label)} className="w-60" />
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <ul className="grid divide-y" aria-label="Columns in your file">
                {preview.headers.map((header) => (
                  <li key={header} className="grid gap-2 py-3 first:pt-0 last:pb-0">
                    <p className="font-medium break-words">{header}</p>
                    <Examples values={preview.examples[header] ?? []} />
                    <TargetSelect header={header} mapping={mapping} onTarget={setTarget} className="w-full data-[size=default]:h-11" />
                    {customInfo.has(header) && (
                      <CustomField header={header} label={customLabelOf(mapping[header])} info={customInfo.get(header)!} onLabel={(label) => setLabel(header, label)} className={cn("w-full", touch)} />
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="grid max-w-xs gap-2">
              <Label htmlFor="country">Country for phone numbers without a country code (optional, overrides the organization default)</Label>
              <Input
                id="country"
                value={country}
                onChange={(e) => {
                  setSummary(null);
                  setCountry(e.target.value.toUpperCase());
                }}
                maxLength={2}
                placeholder="KR, US, ..."
                className={touch}
              />
            </div>
            <p className="text-sm text-muted-foreground">MiaSDR matches leads already in your database by email or LinkedIn profile. A value in your file replaces the stored value. An empty cell never erases anything.</p>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {blocking && (
              <p role="alert" className="text-sm text-destructive">
                {blocking}
              </p>
            )}
            {summary && <SummaryPanel summary={summary} panelRef={summaryRef} />}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" className={buttonClass} onClick={() => setStep(1)} disabled={busy !== null}>
              Back
            </Button>
            <Link href="/leads" className={cn(buttonVariants({ variant: "ghost" }), buttonClass)}>
              Cancel
            </Link>
            {summary ? (
              <Button className={cn(buttonClass, "sm:ml-auto")} onClick={runImport} disabled={busy !== null || Boolean(blocking) || !summaryChangesAnything(summary)}>
                {busy === "importing" ? "Importing…" : confirmLabel(summary)}
              </Button>
            ) : (
              <Button className={cn(buttonClass, "sm:ml-auto")} onClick={review} disabled={busy !== null || Boolean(blocking) || preview.totalRows === 0}>
                {busy === "checking" ? "Checking…" : "Review import"}
              </Button>
            )}
          </div>
        </section>
      )}

    </div>
  );
}

function Examples({ values }: { values: string[] }) {
  if (values.length === 0) return <p className="text-sm text-muted-foreground">No values</p>;
  return (
    <ul className="grid gap-0.5 text-sm text-muted-foreground">
      {values.map((value) => (
        <li key={value} className="truncate" title={value}>
          {value}
        </li>
      ))}
    </ul>
  );
}

function TargetSelect({ header, mapping, onTarget, className }: { header: string; mapping: Mapping; onTarget: (header: string, value: string | null) => void; className: string }) {
  return (
    <Select items={TARGETS} value={selectValue(mapping[header] ?? "skip")} onValueChange={(v) => onTarget(header, v)}>
      <SelectTrigger className={className} aria-label={`Import ${header} as`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {TARGET_GROUPS.map((group) => (
          <SelectGroup key={group.label}>
            <SelectLabel>{group.label}</SelectLabel>
            {group.options.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

function SummaryPanel({ summary, panelRef }: { summary: ImportSummary; panelRef: Ref<HTMLElement> }) {
  const empty = !summaryChangesAnything(summary);
  const all: Array<{ label: string; count: number; examples?: Issue[]; always?: boolean }> = [
    { label: "New leads", count: summary.created, always: true },
    { label: "Existing leads to update", count: summary.updated, always: true },
    { label: "Already up to date", count: summary.unchanged, always: true },
    ...summary.skipped.map((g) => ({ label: SKIP_LABELS[g.kind], count: g.count, examples: g.examples })),
    { label: "Repeated in the file, merged into the first row", count: summary.duplicates.count, examples: summary.duplicates.examples },
    { label: "Values ignored, the row is still imported", count: summary.ignored.count, examples: summary.ignored.examples },
  ];
  const rows = all.filter((r) => r.always || r.count > 0);
  return (
    <section ref={panelRef} tabIndex={-1} role="status" aria-labelledby="import-summary-title" className="grid gap-4 rounded-lg bg-muted/50 p-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
      <div className="grid gap-1">
        <h3 id="import-summary-title" className="text-sm font-semibold">
          Review before importing
        </h3>
        <p className="text-sm text-muted-foreground">
          {count(summary.totalRows)} {summary.totalRows === 1 ? "row" : "rows"} read. Nothing is saved until you import. Row numbers count data rows, not the header.
        </p>
      </div>
      <ul className="grid gap-2 text-sm">
        {rows.map((row) => (
          <li key={row.label}>
            <div className="flex justify-between gap-6">
              <span className="text-muted-foreground">{row.label}</span>
              <span className="font-medium tabular-nums">{count(row.count)}</span>
            </div>
            {row.examples && row.examples.length > 0 && (
              <ul className="mt-1 grid gap-0.5 text-xs text-muted-foreground">
                {row.examples.map((example) => (
                  <li key={example.row} className="break-words">
                    Row {count(example.row)}: {example.reason}
                  </li>
                ))}
                {row.count > row.examples.length && <li>{count(row.count - row.examples.length)} more. The result screen lists up to {RESULT_EXAMPLES} rows per kind.</li>}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {summary.overwrites.length > 0 ? (
        <div className="grid gap-1 text-sm">
          <p className="font-medium">Replaces values already stored</p>
          <ul className="grid gap-0.5">
            {summary.overwrites.map((column) => (
              <li key={column.header} className="break-words">
                {column.header}: {count(column.leads)} {column.leads === 1 ? "lead" : "leads"}
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground">Empty cells never erase anything.</p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No stored value is replaced. Empty cells never erase anything.</p>
      )}
      {empty && <p className="text-sm">Nothing would change. Every row is skipped or already up to date. Go back to change the mapping, or choose another file.</p>}
    </section>
  );
}

function CustomField({ header, label, info, onLabel, className }: { header: string; label: string; info: { key: string | null; mergeField: string | null; problem: string | null }; onLabel: (label: string) => void; className: string }) {
  return (
    <div className="mt-2 grid gap-1">
      <Input aria-label={`Field name for ${header}`} value={label} onChange={(e) => onLabel(e.target.value)} className={className} />
      <p className="text-xs text-muted-foreground">
        {info.mergeField ? (
          <>
            Use <code>{`{{${info.mergeField}}}`}</code> in templates. {label.trim().length}/{CUSTOM_LABEL_MAX} characters.
          </>
        ) : (
          <>{label.trim().length}/{CUSTOM_LABEL_MAX} characters.</>
        )}
      </p>
      {info.problem && (
        <p role="alert" className="text-xs text-destructive">
          {info.problem}
        </p>
      )}
    </div>
  );
}

function Result({ report, onReset }: { report: Report; onReset: () => void }) {
  const s = report.stats;
  const doneRef = useRef<HTMLDivElement>(null);
  useEffect(() => doneRef.current?.focus(), []);
  // Only new leads carry this import as their source, so the filtered list holds exactly `created` leads.
  const addable = s.created;
  const rows: Array<[string, number]> = [
    ["New leads", s.created],
    ["Updated", s.updated],
    ["Already up to date", s.unchanged],
    ["Skipped, no valid email or LinkedIn", s.invalid],
    ["Merged duplicate rows in the file", s.duplicatesInFile],
    ["Skipped, email and LinkedIn match different leads", s.conflicts],
    ["New companies", s.companiesCreated],
    ...(s.rawTruncatedRows > 0 ? ([["Rows whose source data was cut to the size limit", s.rawTruncatedRows]] as Array<[string, number]>) : []),
  ];
  const issues = [
    ...report.issues.invalid.map((i) => ({ ...i, kind: "Skipped" })),
    ...report.issues.conflicts.map((i) => ({ ...i, kind: "Conflict" })),
    ...report.issues.duplicates.map((i) => ({ ...i, kind: "Merged" })),
    ...report.issues.warnings.map((i) => ({ ...i, kind: "Note" })),
  ];
  return (
    <div className="max-w-3xl">
      <section className="stack-group pb-section">
        <div ref={doneRef} tabIndex={-1} role="status" className="stack-field outline-none">
          <h2 className="text-base font-semibold">Import finished</h2>
          <p className="text-sm text-muted-foreground">{s.totalRows.toLocaleString("en-US")} rows read.</p>
        </div>
        <div>
          <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-right font-medium tabular-nums">{value.toLocaleString("en-US")}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="flex flex-wrap gap-2">
          {addable > 0 && report.runId && (
            <Link href={`/leads?source=${encodeURIComponent(`import:${report.runId}`)}`} className={cn(buttonVariants())}>
              Add these {addable.toLocaleString("en-US")} to a campaign
            </Link>
          )}
          <Link href="/leads" className={cn(buttonVariants({ variant: addable > 0 && report.runId ? "outline" : "default" }))}>
            View leads
          </Link>
          <Button variant="outline" onClick={onReset}>
            Import another file
          </Button>
        </div>
      </section>
      {issues.length > 0 && (
        <section className="stack-group border-t pt-section">
          <div className="stack-field">
            <h2 className="text-base font-semibold">Rows to check</h2>
            <p className="text-sm text-muted-foreground">Up to {RESULT_EXAMPLES} rows per kind. Row numbers count data rows, not the header.</p>
          </div>
          <div>
            <ul className="grid gap-1 text-sm">
              {issues.map((issue, i) => (
                <li key={i}>
                  <span className="text-muted-foreground">
                    {issue.kind}, row {issue.row}:
                  </span>{" "}
                  {issue.reason}
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </div>
  );
}
