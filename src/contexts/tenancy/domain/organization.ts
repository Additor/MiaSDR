export const ORG_NAME_MAX = 80;

/** Why an organization name is unusable, or null when it is fine. */
export function organizationNameProblem(name: unknown): string | null {
  if (typeof name !== "string" || name.trim() === "") return "Enter an organization name.";
  if (name.trim().length > ORG_NAME_MAX) return `The name is at most ${ORG_NAME_MAX} characters.`;
  if (/[\u0000-\u001f\u007f]/.test(name)) return "The name cannot contain control characters.";
  return null;
}
