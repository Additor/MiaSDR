"use client";

import { useRouter } from "next/navigation";
import { ChevronDownIcon, MoreHorizontalIcon } from "lucide-react";
import { useState } from "react";
import { useSelection } from "@/components/shell/selection";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { callApi } from "@/app/_lib/api-client";
import { cn } from "@/components/ui/utils";
import { BulkDncDialog } from "./bulk-dnc-dialog";
import { contactsBarModel, selectedText } from "./contacts-bulk";

const NO_IDS: string[] = [];

/** The file name the export route names in its `content-disposition`, else the route's own pattern. */
function fileNameOf(response: Response): string {
  const named = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "");
  return named?.[1] ?? `contacts-${new Date().toISOString().slice(0, 10)}.csv`;
}

/**
 * The Contacts selection bar, the Leads bar's model: it sticks to the bottom of the viewport after the table, keeps
 * the height of one row of controls whether or not anything is ticked, and keeps its status line mounted so a screen reader
 * hears the count change. `query` is the list filter (`q`, `owner`, `stage`) for "Select all matching".
 */
export function ContactsBulkBar({ total, pageIds, query }: { total: number; pageIds: string[]; query: string }) {
  const router = useRouter();
  const { selectedIds: ids, select, clear } = useSelection();
  const [busy, setBusy] = useState<"gathering" | "exporting" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The ids the do not contact dialog works on, fixed when it opens.
  const [dncIds, setDncIds] = useState<string[] | null>(null);
  const model = contactsBarModel({ selectedCount: ids.length, total });
  const offPage = ids.some((id) => !pageIds.includes(id));

  async function selectAllMatching() {
    setBusy("gathering");
    setError(null);
    const result = await callApi<{ ids: string[]; capped: boolean }>(`/api/contacts/ids${query ? `?${query}` : ""}`, "GET");
    setBusy(null);
    if (!result.ok || !result.data) return setError(`${result.error ?? "Could not read the matching contacts."} Try again, or tick rows by hand.`);
    select(result.data.ids, true);
  }

  /** Export selected posts the ids (up to 5,000) and saves the CSV the route answers. */
  async function exportSelected() {
    setBusy("exporting");
    setError(null);
    try {
      const response = await fetch("/api/contacts/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        return setError(body?.error ?? "The export did not finish. Try again.");
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = fileNameOf(response);
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("The export did not finish. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="sticky bottom-0 z-20 min-h-14 pb-[env(safe-area-inset-bottom)]" data-testid="selection-bar">
        <div className={cn("flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-sm", ids.length > 0 && "border bg-background shadow-md ring-1 ring-foreground/5")}>
          <div role="status" className="max-md:order-1 max-md:min-h-11 max-md:flex-1 max-md:content-center md:mr-1">
            {ids.length > 0 && (busy === "gathering" ? "Selecting all matching contacts…" : selectedText(ids.length, offPage))}
          </div>
          {error && (
            <span role="alert" className="basis-full text-destructive max-md:order-7">
              {error}
            </span>
          )}
          {/* On a phone the count and Clear selection share the first row; the actions take the second. */}
          <div aria-hidden className="-mb-2 hidden basis-full max-md:order-3 max-md:block" />
          {model.visible.includes("export") && (
            <Button variant="outline" disabled={busy !== null} className="max-md:order-4 max-md:h-11 max-md:flex-1" onClick={() => void exportSelected()}>
              {busy === "exporting" ? "Exporting…" : "Export selected"}
            </Button>
          )}
          {model.visible.includes("doNotContact") && (
            <Button variant="outline" disabled={busy !== null} className="max-md:order-5 max-md:h-11 max-md:flex-1" onClick={() => setDncIds(ids)}>
              Mark do not contact
            </Button>
          )}
          {model.visible.includes("clear") && (
            <Button variant="ghost" className="text-muted-foreground max-md:order-2 max-md:h-11" onClick={clear}>
              Clear selection
            </Button>
          )}
          {model.visible.includes("more") && model.selectAll && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" disabled={busy !== null} className="max-md:order-6 max-md:size-11 md:ml-auto" />}>
                <MoreHorizontalIcon aria-hidden className="md:hidden" />
                <span className="max-md:sr-only">More actions</span>
                <ChevronDownIcon aria-hidden className="max-md:hidden" />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="end" className="w-auto min-w-56">
                <DropdownMenuItem className="max-md:min-h-11" onClick={() => void selectAllMatching()}>
                  {model.selectAll}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      <BulkDncDialog
        open={dncIds !== null}
        ids={dncIds ?? NO_IDS}
        onClose={(report) => {
          setDncIds(null);
          if (!report) return;
          clear();
          router.refresh();
        }}
      />
    </>
  );
}
