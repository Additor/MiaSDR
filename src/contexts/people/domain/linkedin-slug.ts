/** A bare LinkedIn slug: letters in any script, digits, `_ % . -`. A slug decoded from a URL can hold Hangul or accents. */
export const BARE_SLUG = /^[\p{L}\p{N}_%.-]+$/u;
