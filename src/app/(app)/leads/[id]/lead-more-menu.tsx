"use client";

import { EllipsisIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { deleteConfirmation, type DeleteQualification } from "@/contexts/people/application/lead-delete-terms";
import { callApi } from "@/app/_lib/api-client";
import { AddLeadToCampaign } from "../_components/add-to-campaign";
import { MakeContactDialog } from "./make-contact-dialog";

/**
 * The lead's rare actions in a ghost More menu in the header, as company and deal pages keep theirs: Add to campaign while the
 * lead's status does not put it first, Make contact without a deal, then Delete lead. A lead the rules protect still offers
 * Delete lead; the dialog says why it stays and has nothing to confirm. The server applies the same rules again.
 */
export function LeadMoreMenu({
  id,
  name,
  qualification,
  returnTo,
  addToCampaign,
}: {
  id: string;
  name: string;
  qualification: DeleteQualification;
  returnTo: string;
  /** Offer Add to campaign here: the header shows it as the main action only for a lead that is in no live campaign. */
  addToCampaign: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [campaignOpen, setCampaignOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);

  async function remove() {
    const result = await callApi(`/api/leads/${id}`, "DELETE");
    // ConfirmDialog shows the thrown message and keeps the dialog open.
    if (!result.ok) throw new Error(result.error ?? "The lead could not be deleted. Try again.");
    toast.success(`Deleted ${name}.`);
    router.push(returnTo);
    router.refresh();
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" aria-label={`More actions for ${name}`} />}>
          <EllipsisIcon aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-48">
          {addToCampaign && (
            <DropdownMenuItem className="max-sm:min-h-11" onClick={() => setCampaignOpen(true)}>
              Add to campaign…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem className="max-sm:min-h-11" onClick={() => setContactOpen(true)}>
            Make contact without a deal…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" className="max-sm:min-h-11" onClick={() => setOpen(true)}>
            Delete lead
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {addToCampaign && <AddLeadToCampaign personId={id} open={campaignOpen} onOpenChange={setCampaignOpen} />}
      <MakeContactDialog personId={id} name={name} open={contactOpen} onOpenChange={setContactOpen} />
      {qualification.canDelete ? (
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          title={`Delete ${name}?`}
          description={deleteConfirmation(qualification)}
          confirmLabel="Delete lead"
          cancelLabel="Keep lead"
          pendingLabel="Deleting…"
          destructive
          onConfirm={remove}
        />
      ) : (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent data-testid="delete-qualification">
            <DialogHeader>
              <DialogTitle>{`${name} cannot be deleted`}</DialogTitle>
              <DialogDescription>{qualification.detail}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
