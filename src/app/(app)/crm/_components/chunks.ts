/** Splits `items` into consecutive slices of `size`; the last slice holds the rest. Bulk dialogs send one request per slice. */
export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
