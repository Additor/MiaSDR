/** More pages than any list holds. A larger offset could also overflow what Postgres reads as a bigint. */
const MAX_PAGE = 1_000_000;

/** A list's `page` URL value as a page number: 1 for anything that is not a whole number of at least 1, such as `abc`, `Infinity` or `1e30`. */
export function parsePageParam(raw: string | undefined): number {
  const page = Math.trunc(Number(raw));
  return Number.isSafeInteger(page) && page >= 1 ? Math.min(page, MAX_PAGE) : 1;
}
