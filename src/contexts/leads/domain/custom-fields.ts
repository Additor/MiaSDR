/**
 * Pure helpers for user-defined columns. Kept apart from normalize.ts so the
 * import wizard can use them without bundling the phone number library.
 */

/** FNV-1a, base 36: a short, stable suffix that keeps labels with the same Latin letters apart. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * The immutable key for a user-defined column, from its label. Labels with
 * characters outside ASCII after accent stripping (Korean, Japanese, ß) get a
 * hash suffix, so "회사 규모" and "회사 이름" do not collapse into one key.
 * Null only for an empty label.
 */
export function customColumnKey(label: string): string | null {
  const trimmed = label.trim();
  if (!trimmed) return null;
  const folded = trimmed.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const slug = folded
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  const hasNonAscii = /[^\x00-\x7f]/.test(folded);
  const hasLetterOrDigit = /[\p{L}\p{N}]/u.test(folded);
  if (!hasLetterOrDigit) return null;
  if (!slug) return `x_c_${shortHash(trimmed)}`;
  return hasNonAscii ? `x_${slug}_${shortHash(trimmed)}` : `x_${slug}`;
}

/** Longest label a user-defined column may have. */
export const CUSTOM_LABEL_MAX = 60;

/**
 * The merge field name a column label produces: camelCase over letters and digits.
 * "Job Title" gives `jobTitle`, "업종" stays `업종`. Null when the label has no letter or digit.
 */
export function mergeFieldKey(label: string): string | null {
  const words = label
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (words.length === 0) return null;
  return words.map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join("");
}


export interface LabelIssue {
  label: string;
  /** The immutable column key, or null when the label cannot make one. */
  key: string | null;
  /** The merge field a template writes, or null. */
  mergeField: string | null;
  /** A message when this label cannot be imported as is. */
  problem: string | null;
}

/**
 * Describes what each custom label produces and flags the ones that cannot be
 * imported: too long, no letters or digits, or the same key as an earlier label.
 */
export function describeCustomLabels(labels: string[]): LabelIssue[] {
  const seenKeys = new Map<string, string>();
  const seenFields = new Map<string, string>();
  return labels.map((raw) => {
    const label = raw.trim();
    const key = customColumnKey(label);
    const mergeField = mergeFieldKey(label);
    let problem: string | null = null;
    if (label.length > CUSTOM_LABEL_MAX) {
      problem = `The label has ${label.length} characters. The limit is ${CUSTOM_LABEL_MAX}. Shorten it.`;
    } else if (!key || !mergeField) {
      problem = "The label needs at least one letter or digit.";
    } else {
      const sameKey = seenKeys.get(key);
      const sameField = seenFields.get(mergeField.toLowerCase());
      if (sameKey !== undefined || sameField !== undefined) {
        problem = `Same merge field as "${sameKey ?? sameField}". Rename one of them.`;
      } else {
        seenKeys.set(key, label);
        seenFields.set(mergeField.toLowerCase(), label);
      }
    }
    return { label, key, mergeField, problem };
  });
}
