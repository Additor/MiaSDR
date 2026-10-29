/**
 * Numbers as the app prints them: grouped the English way ("1,204"), the same on the server and in the browser, so a
 * hydrated page never shifts. `formatCount` is the bare number; `countOf` puts the noun after it in the right number.
 */
export const formatCount = (n: number): string => n.toLocaleString("en-US");

/** "1 lead", "1,204 leads". Pass `many` for a noun that does not take an s ("2 replies"). */
export const countOf = (n: number, one: string, many = `${one}s`): string => `${formatCount(n)} ${n === 1 ? one : many}`;
