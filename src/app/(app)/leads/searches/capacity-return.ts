import { formatDateTime } from "@/shared/format-time";

/**
 * When search capacity returns, as text in the organization's zone ("2026-03-08 09:00 Asia/Seoul"). The input is the ISO
 * string or Date from the capacity view. The zone comes from the layout's provider, so the server render and the browser
 * print the same text. Null when no return time is known.
 */
export function capacityReturnText(value: string | Date | null | undefined, timeZone: string): string | null {
  if (value === null || value === undefined) return null;
  const text = formatDateTime(value, timeZone);
  return text === "" ? null : `${text} ${timeZone}`;
}
