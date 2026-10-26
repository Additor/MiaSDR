import type { AppliedFilter } from "@/components/shell/filter-chip";
import { SelectField } from "@/components/shell/filter-fields";

/** One choice of a deal filter. */
export interface DealFilterOption {
  value: string;
  label: string;
}

/**
 * The latest deal's owner and stage as fields of a Filters popover. `owners` holds "Me", the other members and "No
 * owner". A pipeline without stages yet has no ids to filter by, so the stage field waits for the first deal.
 */
export function DealFilterFields({ owner, stage, owners, stages }: { owner?: string; stage?: string; owners: DealFilterOption[]; stages: DealFilterOption[] }) {
  return (
    <>
      <SelectField label="Deal owner" name="owner" defaultValue={owner ?? ""}>
        <option value="">Any deal owner</option>
        {owners.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </SelectField>
      {stages.length > 0 && (
        <SelectField label="Deal stage" name="stage" defaultValue={stage ?? ""}>
          <option value="">Any stage</option>
          {stages.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectField>
      )}
    </>
  );
}

/** The deal filters in force as chips. `without` is the list URL without that filter. */
export function dealFilterChips({ owner, stage, owners, stages, without }: { owner?: string; stage?: string; owners: DealFilterOption[]; stages: DealFilterOption[]; without: (key: "owner" | "stage") => string }): AppliedFilter[] {
  const chips: AppliedFilter[] = [];
  if (owner) chips.push({ key: "owner", name: "Deal owner", value: owners.find((o) => o.value === owner)?.label ?? "Unknown member", href: without("owner") });
  if (stage) chips.push({ key: "stage", name: "Deal stage", value: stages.find((o) => o.value === stage)?.label ?? "Unknown stage", href: without("stage") });
  return chips;
}
