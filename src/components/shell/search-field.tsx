import { SearchIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/components/ui/utils";

/**
 * The search box of a list: the icon sits inside the field and Enter submits the surrounding form. The submit button
 * stays for screen readers and keyboards that look for it. Put it inside a GET form that carries the list's other
 * params as hidden inputs.
 */
export function SearchField({ label, defaultValue, placeholder, name = "q", maxLength, className }: { label: string; defaultValue?: string; placeholder?: string; name?: string; maxLength?: number; className?: string }) {
  return (
    <>
      <label className={cn("relative block min-w-48 max-w-md flex-1", className)}>
        <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input name={name} type="search" aria-label={label} defaultValue={defaultValue} placeholder={placeholder} maxLength={maxLength} className="pl-8 max-sm:h-11" />
      </label>
      <button type="submit" className="sr-only">
        Search
      </button>
    </>
  );
}
