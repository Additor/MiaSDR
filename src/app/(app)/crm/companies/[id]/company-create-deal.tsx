"use client";

import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { CreateDealButton, CreateDealDialog, type CreateDealDialogProps, type CreateDealPerson } from "../../_components/create-deal-dialog";

type Shared = Pick<CreateDealDialogProps, "members" | "currentUserId" | "stages">;

/**
 * Create deal on a company page. A deal belongs to a contact, so the button asks which one: with one contact it opens
 * the dialog for them, with more it lists them first. A company without contacts gets no button.
 */
export function CompanyCreateDeal({ contacts, ...shared }: Shared & { contacts: CreateDealPerson[] }) {
  const [person, setPerson] = useState<CreateDealPerson | null>(null);
  const [open, setOpen] = useState(false);

  if (contacts.length === 0) return null;
  if (contacts.length === 1) return <CreateDealButton mode="contact" person={contacts[0]} {...shared} />;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button />}>
          Create deal
          <ChevronDownIcon aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>For which contact?</DropdownMenuLabel>
            {contacts.map((contact) => (
            <DropdownMenuItem
              key={contact.id}
              className="max-sm:min-h-11"
              onClick={() => {
                setPerson(contact);
                setOpen(true);
              }}
            >
              {contact.name ?? contact.email ?? "Unnamed contact"}
            </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {person && <CreateDealDialog mode="contact" person={person} open={open} onOpenChange={setOpen} {...shared} />}
    </>
  );
}
