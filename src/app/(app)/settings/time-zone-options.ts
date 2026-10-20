/**
 * Choice list for a time zone Select. `current` joins the list when this runtime does not know it, so a saved value
 * never disappears, and UTC always sits first.
 */
export function timeZoneOptions(supported: string[], current?: string | null): string[] {
  const zones = supported.filter((zone) => zone !== "UTC");
  if (current && current !== "UTC" && !zones.includes(current)) zones.unshift(current);
  return ["UTC", ...zones];
}
