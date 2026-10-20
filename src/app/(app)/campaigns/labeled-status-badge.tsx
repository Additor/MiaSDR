import { StatusBadge } from "@/components/shell/status-badge";

/** A status badge with a human label. `status` picks the color, `label` is the text. */
export function LabeledStatusBadge({ status, label }: { status: string; label: string }) {
  return <StatusBadge status={status} label={label} />;
}
