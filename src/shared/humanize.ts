/**
 * Fallback label for a stored token such as "do_not_contact", "linkedIn-invite" or "email,linkedin". Domain pages keep
 * their own label maps for words that need exact copy; this only keeps an unmapped value readable.
 */
export function humanizeToken(token: string): string {
  return token
    .split(",")
    .map((item) => sentenceCase(item))
    .filter((item) => item !== "")
    .join(", ");
}

function sentenceCase(item: string): string {
  const words = item
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-\s]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
