/** The fields of an onboarding step that the hub reads. */
export interface SetupStep {
  id: string;
  title: string;
  description: string;
  optional: boolean;
  status: "done" | "todo" | "attention";
  detail: string | null;
  href: string;
}

export interface SetupLink {
  id: string;
  title: string;
  href: string;
  /** One line on why the step is open: the count behind an attention status, otherwise the step's own description. */
  reason: string;
}

/**
 * The required onboarding steps still open, in checklist order. Optional steps and finished steps stay out, so the list
 * is empty once setup is done. Reads whatever steps the checklist returns and names none of them.
 */
export function openSetupLinks(steps: SetupStep[]): SetupLink[] {
  return steps
    .filter((step) => !step.optional && step.status !== "done")
    .map((step) => ({ id: step.id, title: step.title, href: step.href, reason: step.status === "attention" && step.detail ? step.detail : step.description }));
}
