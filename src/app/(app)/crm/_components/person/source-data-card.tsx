"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { callApi } from "@/lib/api-client";
import { RecordDisclosure } from "../record/record-header";

type Entry = { key: string; value: string };

/**
 * Columns of the imported file that no lead field took, folded behind their count at the end of the page. A person opens them
 * now and then, to copy them or to map one to a custom field, so the per-column Map buttons stay out of sight until then.
 */
export function SourceDataCard({ person, company, companyName }: { person: Entry[]; company: Entry[]; companyName: string | null }) {
  const [mapping, setMapping] = useState<string | null>(null);

  // Nothing unmapped: the section stays away. The import screen explains where unmapped columns go.
  if (person.length === 0 && company.length === 0) return null;

  async function copy(entries: Entry[]) {
    const text = entries.map((e) => `${e.key}: ${e.value}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Imported fields copied.");
    } catch {
      toast.error("Copy is blocked by the browser. Select the text and copy it by hand.");
    }
  }

  return (
    <RecordDisclosure title="Imported fields" count={person.length + company.length} testId="imported-fields">
      <p className="text-sm text-muted-foreground">Columns of the imported file that were not mapped to a lead field. Map one to a custom field to use it in the table and in templates.</p>
      <div className="stack-group">
        {person.length > 0 && (
          <div className="grid gap-2">
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={() => copy(person)}>
                Copy
              </Button>
            </div>
            <dl className="grid gap-2" data-testid="source-data">
              {person.map((e) => (
                <div key={e.key} className="grid gap-1 border-b pb-2 sm:grid-cols-[14rem_1fr_auto] sm:items-start sm:gap-3">
                  <dt className="text-sm font-medium break-words">{e.key}</dt>
                  <dd className="text-sm break-words whitespace-pre-wrap text-muted-foreground">{e.value}</dd>
                  <div>
                    <Button variant="ghost" size="sm" className="max-sm:h-11" aria-label={`Map this field: ${e.key}`} onClick={() => setMapping(mapping === e.key ? null : e.key)}>
                      Map this field
                    </Button>
                  </div>
                  {mapping === e.key && <MapForm rawKey={e.key} onDone={() => setMapping(null)} />}
                </div>
              ))}
            </dl>
          </div>
        )}
        {company.length > 0 && (
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium">Company{companyName ? `: ${companyName}` : ""}</h4>
              <Button variant="outline" size="sm" onClick={() => copy(company)}>
                Copy
              </Button>
            </div>
            <dl className="grid gap-2" data-testid="company-source-data">
              {company.map((e) => (
                <div key={e.key} className="grid gap-1 border-b pb-2 sm:grid-cols-[14rem_1fr] sm:gap-3">
                  <dt className="text-sm font-medium break-words">{e.key}</dt>
                  <dd className="text-sm break-words whitespace-pre-wrap text-muted-foreground">{e.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
    </RecordDisclosure>
  );
}

function MapForm({ rawKey, onDone }: { rawKey: string; onDone: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(rawKey.slice(0, 100));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setPending(true);
    setError(null);
    const result = await callApi<{ name: string; updated: number }>("/api/leads/raw/map", "POST", { rawKey, name });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const updated = result.data?.updated ?? 0;
    toast.success(`${updated} ${updated === 1 ? "lead" : "leads"} updated in "${result.data?.name ?? name}".`);
    onDone();
    router.refresh();
  }

  return (
    <form
      className="col-span-full flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Input aria-label="Custom field name" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} className="max-w-64" />
      <Button type="submit" size="sm" disabled={pending || name.trim() === ""}>
        Create and fill field
      </Button>
      <span className="text-xs text-muted-foreground">Fills every lead that has this column and no value yet.</span>
      {error && (
        <p role="alert" className="w-full text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
