"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { orThrow, runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { useApiAction } from "@/app/_lib/use-api-action";
import { isActiveRun, MIA_MAX_INPUT_CHARS, MIA_RUN_LABELS, type MiaCapability, type MiaRunStatus } from "@/contexts/mia/domain/mia-run";

type FillMode = "url" | "text";

/** A person gives Mia one address or some text. A model never picks where a run starts. */
export function FillWithMiaButton({ unavailable, variant = "outline" }: { unavailable: string | null; variant?: "default" | "outline" }) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<FillMode>("url");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");

  async function start() {
    const body = mode === "url" ? { capability: "brain_fill_url", url } : { capability: "brain_fill_text", text };
    orThrow(await runApiAction(callApi("/api/mia/runs", "POST", body), { refresh: () => router.refresh() }));
    toast.success("Mia started. Its suggestions appear here for you to review.");
    setUrl("");
    setText("");
  }

  return (
    <>
      <Button variant={variant} disabled={unavailable !== null} title={unavailable ?? undefined} onClick={() => setOpen(true)}>
        Fill with Mia
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Fill Brain with Mia"
        description="Mia reads this and suggests items. Nothing goes into Brain until you review it."
        confirmLabel="Start"
        pendingLabel="Starting…"
        confirmDisabled={mode === "url" ? url.trim() === "" : text.trim() === ""}
        onConfirm={start}
      >
        <FieldGroup>
          <FillModeButtons mode={mode} onChange={setMode} />
          {mode === "url" ? (
            <Field>
              <FieldLabel htmlFor={`${id}-url`}>Your company&apos;s website</FieldLabel>
              <Input id={`${id}-url`} type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" maxLength={2048} />
              <FieldDescription>Mia reads up to 6 pages of this site and sends their text to your AI provider. A site that draws itself with scripts has nothing to read, so paste its text instead.</FieldDescription>
            </Field>
          ) : (
            <Field>
              <FieldLabel htmlFor={`${id}-text`}>Text to read</FieldLabel>
              <Textarea id={`${id}-text`} className="min-h-48" value={text} onChange={(e) => setText(e.target.value)} maxLength={MIA_MAX_INPUT_CHARS} />
              <FieldDescription>Mia sends this text to your AI provider. Leave out anything about customers you would not put in Brain.</FieldDescription>
            </Field>
          )}
        </FieldGroup>
      </ConfirmDialog>
    </>
  );
}

function FillModeButtons({ mode, onChange }: { mode: FillMode; onChange: (mode: FillMode) => void }) {
  return (
    <div role="group" aria-label="What Mia reads" className="flex gap-2">
      <Button type="button" size="sm" variant={mode === "url" ? "secondary" : "ghost"} aria-pressed={mode === "url"} onClick={() => onChange("url")}>
        Website
      </Button>
      <Button type="button" size="sm" variant={mode === "text" ? "secondary" : "ghost"} aria-pressed={mode === "text"} onClick={() => onChange("text")}>
        Text
      </Button>
    </div>
  );
}

export function SortWithMiaButton({ itemId, unavailable }: { itemId: string; unavailable: string | null }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const { isBusy, run } = useApiAction();
  const start = () =>
    run(itemId, async () => {
      setError(null);
      const result = await runApiAction(callApi("/api/mia/runs", "POST", { capability: "brain_sort", itemId }), { refresh: () => router.refresh() });
      if (!result.ok) return setError(result.error);
      toast.success("Mia is sorting this. Review its suggestion under Suggestions.");
    });
  return (
    <>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button variant="outline" disabled={unavailable !== null || isBusy(itemId)} title={unavailable ?? undefined} onClick={() => void start()}>
        {isBusy(itemId) ? "Starting…" : "Sort with Mia"}
      </Button>
    </>
  );
}

export interface MiaRunLine {
  id: string;
  capability: MiaCapability;
  status: MiaRunStatus;
  site: string | null;
  suggestionCount: number;
  error: string | null;
  cancelRequested: boolean;
}

const POLL_MS = 3_000;

function lineOf(run: MiaRunLine): string {
  const what = run.site ? `Reading ${run.site}` : MIA_RUN_LABELS[run.capability];
  const found = run.suggestionCount === 1 ? "1 suggestion" : `${run.suggestionCount} suggestions`;
  if (run.status === "waiting_limit") return `${what}: waiting for tomorrow's tokens. ${found} so far.`;
  if (run.cancelRequested) return `${what}: stopping.`;
  if (isActiveRun(run.status)) return `${what}: ${found} so far.`;
  if (run.status === "succeeded") return `${what}: finished with ${found}.`;
  if (run.status === "cancelled") return `${what}: stopped.`;
  return `${what}: ${run.error ?? "it failed."}`;
}

/** What Mia is doing now and what just ended. The page refreshes while a job runs, since the job lives on the server. */
export function MiaRunLines({ runs }: { runs: MiaRunLine[] }) {
  const router = useRouter();
  const { isBusy, run } = useApiAction();
  const [error, setError] = useState<string | null>(null);
  const active = runs.some((r) => isActiveRun(r.status));
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [active, router]);

  if (runs.length === 0) return null;
  const stop = (id: string) =>
    run(id, async () => {
      setError(null);
      const result = await runApiAction(callApi(`/api/mia/runs/${id}/cancel`, "POST", {}), { refresh: () => router.refresh() });
      if (!result.ok) setError(result.error);
    });
  return (
    <div role="status" className="stack-field text-sm" data-testid="mia-runs">
      {runs.map((r) => (
        <div key={r.id} className="flex flex-wrap items-center gap-2" data-testid="mia-run">
          <span className={r.status === "failed" ? "text-destructive" : "text-muted-foreground"}>{lineOf(r)}</span>
          {isActiveRun(r.status) && !r.cancelRequested && (
            <Button size="sm" variant="ghost" disabled={isBusy(r.id)} onClick={() => void stop(r.id)}>
              Stop
            </Button>
          )}
        </div>
      ))}
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
}
