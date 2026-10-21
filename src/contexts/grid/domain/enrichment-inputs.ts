/** The parts of an action spec the input rules read. The Tables UI passes its own copy of the spec. */
interface InputRules {
  inputs: ReadonlyArray<{ key: string; name: string; required: boolean }>;
  accepts?: string[][];
}

/**
 * Whether `has` covers an action: every required input, and every input of at least one combination in `accepts`
 * when the action lists any. Used on mapped columns when a column is saved and on cell values when a cell runs.
 */
export function inputsCovered(spec: InputRules, has: (key: string) => boolean): boolean {
  if (!spec.inputs.every((input) => !input.required || has(input.key))) return false;
  return !spec.accepts?.length || spec.accepts.some((combination) => combination.every(has));
}

/** The combinations an action accepts, in words: "Email, or LinkedIn URL, or Full name with Company domain". */
export function acceptsText(spec: InputRules): string {
  const name = (key: string) => spec.inputs.find((input) => input.key === key)?.name ?? key;
  const combinations = spec.accepts?.length ? spec.accepts : [spec.inputs.filter((input) => input.required).map((input) => input.key)];
  return combinations.map((combination) => combination.map(name).join(" with ")).join(", or ");
}
