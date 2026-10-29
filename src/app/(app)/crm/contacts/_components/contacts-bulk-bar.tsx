"use client";

import { useRouter } from "next/navigation";
import { ChevronDownIcon, MoreHorizontalIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { BulkBar } from "@/components/shell/bulk-bar";
import { useBarScrollPadding, useBulkStep, useSelection } from "@/components/shell/selection";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { callApi } from "@/app/_lib/api-client";
import { BulkDncDialog } from "./bulk-dnc-dialog";
import { contactsBarModel, selectedText } from "./contacts-bulk";

const NO_IDS: string[] = [];

/** The file name the export route names in its `content-disposition`, else the route's own pattern. */
function fileNameOf(response: Response): string {
  const named = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "");
  return named?.[1] ?? `contacts-${new Date().toISOString().slice(0, 10)}.csv`;
}

/**
 * The Contacts selection bar on the shell's `BulkBar`, the Leads bar's model: Export selected and Mark do not contact,
 * Clear selection, then More with "Select all matching". `query` is the list filter (`q`, `owner`, `stage`) for "Select
 * all matching".
 */
export function ContactsBulkBar({ total, pageIds, query }: { total: number; pageIds: string[]; query: string }) {
  const router = useRouter();
  const { selectedIds: ids, select, clear } = useSelection();
  const [busy, setBusy] = useState<"gathering" | "exporting" | null>(null);
  const { error, setError, begin } = useBulkStep(ids.length);
  const bar = useRef<HTMLDivElement>(null);
  useBarScrollPadding(bar, ids.length > 0);
  // The ids the do not contact dialog works on, fixed when it opens.
  const [dncIds, setDncIds] = useState<string[] | null>(null);
  const model = contactsBarModel({ selectedCount: ids.length, total });
  const offPage = ids.some((id) => !pageIds.includes(id));

  async function selectAllMatching() {
    const current = begin();
    setBusy("gathering");
    setError(null);
    const result = await callApi<{ ids: string[]; capped: boolean }>(`/api/contacts/ids${query ? `?${query}` : ""}`, "GET");
    setBusy(null);
    // Cleared while the request ran: the answer belongs to a selection the person dropped.
    if (!current()) return;
    if (!result.ok || !result.data) return setError(`${result.error ?? "Could not read the matching contacts."} Try again, or tick rows by hand.`);
    select(result.data.ids, true);
  }

  /** Export selected posts the ids (up to 5,000) and saves the CSV the route answers. */
  async function exportSelected() {
    const current = begin();
    // After Clear or Esc the bar has no line for the reason, so a failure goes to a toast.
    const fail = (reason: string) => {
      if (current()) setError(reason);
      else toast.error(reason);
    };
    setBusy("exporting");
    setError(null);
    try {
      const response = await fetch("/api/contacts/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        return fail(body?.error ?? "The export did not finish. Try again.");
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = fileNameOf(response);
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      fail("The export did not finish. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <BulkBar
        count={ids.length}
        barRef={bar}
        status={busy === "gathering" ? "Selecting all matching contacts…" : selectedText(ids.length, offPage)}
        error={error}
        actions={
          <>
            {model.visible.includes("export") && (
              <Button variant="outline" disabled={busy !== null} onClick={() => void exportSelected()}>
                {busy === "exporting" ? "Exporting…" : "Export selected"}
              </Button>
            )}
            {model.visible.includes("doNotContact") && (
              <Button variant="outline" disabled={busy !== null} onClick={() => setDncIds(ids)}>
                Mark do not contact
              </Button>
            )}
          </>
        }
        onClear={model.visible.includes("clear") ? clear : undefined}
        more={
          model.visible.includes("more") &&
          model.selectAll && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" disabled={busy !== null} className="max-md:size-11" />}>
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
          )
        }
      />

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
