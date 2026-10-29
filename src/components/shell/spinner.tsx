import { Loader2Icon } from "lucide-react";
import { cn } from "@/components/ui/utils";

/**
 * Work in progress beside the words that name it ("Sending…"). It is decoration: the words carry the state, so a
 * screen reader reads them and not the icon. Pass `label` only where the spinner stands alone, and it becomes the status.
 */
export function Spinner({ label, className }: { label?: string; className?: string }) {
  const icon = <Loader2Icon aria-hidden className={cn("size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none", className)} />;
  if (!label) return icon;
  return (
    <span role="status" className="inline-flex items-center">
      {icon}
      <span className="sr-only">{label}</span>
    </span>
  );
}
