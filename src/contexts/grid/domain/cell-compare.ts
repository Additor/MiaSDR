/**
 * Cell value equality for the compare-and-set in the cells endpoint. An empty cell is `null` or missing,
 * and both count as equal. Objects and arrays compare by content, key order aside, because the client
 * sends back the value it read from JSON.
 */
export function sameCellValue(a: unknown, b: unknown): boolean {
  const left = a === undefined ? null : a;
  const right = b === undefined ? null : b;
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, i) => sameCellValue(item, right[i]));
  const l = left as Record<string, unknown>;
  const r = right as Record<string, unknown>;
  const keys = Object.keys(l);
  return keys.length === Object.keys(r).length && keys.every((key) => key in r && sameCellValue(l[key], r[key]));
}
