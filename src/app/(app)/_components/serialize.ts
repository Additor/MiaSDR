/** What a value looks like after `JSON.stringify`: dates become strings. */
export type Json<T> = T extends Date ? string : T extends Array<infer U> ? Json<U>[] : T extends object ? { [K in keyof T]: Json<T[K]> } : T;

/** Passes server data to a client component. */
export const toJson = <T,>(value: T): Json<T> => JSON.parse(JSON.stringify(value)) as Json<T>;
