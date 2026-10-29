import { InfoTip } from "./info-tip";

export interface SummaryItem {
  label: string;
  /** Pre-formatted text, such as "120" or "14 (11.7%)". */
  value: string | number;
  /** Explains the pair on an info mark after the value (a tooltip on hover and focus, a popover on a tap). */
  hint?: string;
}

/**
 * A compact status row of label and value pairs ("Sent 120 · Replied 14 (11.7%) · Bounced 2"). Small type, tabular
 * numerals, no boxes or accent colors, and it wraps on narrow screens. Use it above a table or inside a detail header.
 * It is not a metric card: do not use it to headline a page.
 */
export function SummaryLine({ items, className }: { items: SummaryItem[]; className?: string }) {
  return (
    <dl className={`flex flex-wrap gap-x-4 gap-y-1 text-sm tabular-nums${className ? ` ${className}` : ""}`}>
      {items.map((item) => (
        <div key={item.label} className="flex items-baseline gap-1.5">
          <dt className="text-muted-foreground">{item.label}</dt>
          <dd className="font-medium">{item.value}</dd>
          {item.hint && (
            <dd className="self-center">
              <InfoTip label={`About ${item.label}`}>{item.hint}</InfoTip>
            </dd>
          )}
        </div>
      ))}
    </dl>
  );
}
