/**
 * The kinds of Brain item. Each value equals a Brain type in Withmia, so an item carries over as it is. `unsorted` holds
 * documents from before the kinds existed; a person sorts them, and no one can create one.
 *
 * The CHECK constraint lists them in this order, and the route matrix seeds the first literal, so `product` stays first:
 * it is the first kind an organization can hold many of.
 */
export const BRAIN_KINDS = ["product", "company_profile", "price_book", "icp", "competitor", "case_study", "testimonial", "objection_handling", "qualification", "unsorted"] as const;

export type BrainKind = (typeof BRAIN_KINDS)[number];

/** The kinds a person can create or sort a document into. */
export type BrainItemKind = Exclude<BrainKind, "unsorted">;

export const BRAIN_ITEM_KINDS = BRAIN_KINDS.filter((kind): kind is BrainItemKind => kind !== "unsorted");

export const isBrainItemKind = (value: unknown): value is BrainItemKind => (BRAIN_ITEM_KINDS as readonly unknown[]).includes(value);

/** The one kind an organization holds a single active item of. A unique index keeps the rule, since no one item can. */
export const SINGLE_ITEM_KIND: BrainItemKind = "company_profile";

/** The groups the Brain page lists items by. They follow how Brain in Withmia groups its types. */
export const BRAIN_GROUPS = {
  company: ["company_profile", "product", "price_book"],
  market: ["icp", "competitor", "case_study", "testimonial"],
  skills: ["objection_handling", "qualification"],
} as const satisfies Record<string, readonly BrainItemKind[]>;

export type BrainGroup = keyof typeof BRAIN_GROUPS;

export const BRAIN_GROUP_LABELS: Record<BrainGroup, string> = { company: "Company", market: "Market", skills: "Skills" };

export const BRAIN_KIND_LABELS: Record<BrainKind, string> = {
  company_profile: "Company profile",
  product: "Product",
  price_book: "Pricing",
  icp: "ICP",
  competitor: "Competitor",
  case_study: "Case study",
  testimonial: "Testimonial",
  objection_handling: "Objection",
  qualification: "Qualification",
  unsorted: "Unsorted",
};
