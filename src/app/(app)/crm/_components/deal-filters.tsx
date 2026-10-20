"use client";

import { useRouter } from "next/navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** One choice of a list filter. The server builds `href`, the list URL with this choice and the other filters kept. */
export interface DealFilterOption {
  value: string;
  label: string;
  href: string;
}

const ANY = "any";

/** A Select that rewrites the list URL. The first item clears the filter. */
function DealFilter({ label, anyLabel, anyHref, value, options }: { label: string; anyLabel: string; anyHref: string; value: string | undefined; options: DealFilterOption[] }) {
  const router = useRouter();
  const items = [{ value: ANY, label: anyLabel, href: anyHref }, ...options];
  const current = value && options.some((o) => o.value === value) ? value : ANY;
  return (
    <Select
      items={items}
      value={current}
      onValueChange={(v) => {
        const item = items.find((i) => i.value === v);
        if (item) router.push(item.href);
      }}
    >
      <SelectTrigger aria-label={label} className="w-40 max-sm:data-[size=default]:h-11">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((i) => (
          <SelectItem key={i.value} value={i.value}>
            {i.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The latest deal's owner. `options` holds "Me", the other members and "No owner". */
export function DealOwnerFilter(props: { anyHref: string; value: string | undefined; options: DealFilterOption[] }) {
  return <DealFilter label="Deal owner" anyLabel="Any deal owner" {...props} />;
}

/** The latest deal's stage, one option per stage of the Pipeline. */
export function DealStageFilter(props: { anyHref: string; value: string | undefined; options: DealFilterOption[] }) {
  return <DealFilter label="Deal stage" anyLabel="Any stage" {...props} />;
}
