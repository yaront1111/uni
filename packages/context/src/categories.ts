import { lifeCategorySchema, type LifeCategory } from '@unai/domain';

/**
 * Life-category views over objects that are stored exactly once (CRT-MEM-02-A).
 *
 * PRD §3: "One event may be relevant to finance, family, work, a relationship, a
 * goal, and a decision at the same time. It is stored once and exposed through
 * many views." PRD §11: the kernel's objects "are not user-facing life
 * categories".
 *
 * Both rules point the same way, so there is no category column anywhere and
 * nothing writes one. A category is *derived* on read from two things that were
 * already recorded once, at ingestion and at canonicalization:
 *
 *  1. the data purposes the evidence item admits (`source_items.allowed_purposes`),
 *     which is also what the row-level policy gates the read on, so the category
 *     view and the purpose-bound view are the same view (PRD §30.2); and
 *  2. the registry namespace of the frame the object belongs to -- a
 *     `finance.*` frame is financial whoever the evidence came from.
 *
 * One evidence item admitting both `PERSONAL_FINANCE` and `FAMILY_COORDINATION`
 * therefore appears in the finance view and in the family view, from one
 * `source_items` row and one set of semantic objects. Adding a category later is
 * adding a rule here, never a migration and never a second copy of the data.
 */

export const CATEGORY_CATALOG_VERSION = 'life-categories-0.1.0';

interface CategoryRule {
  /** Registry namespaces (the part before the first dot of a frame type id). */
  readonly frameNamespaces: readonly string[];
  /** Frame type ids that belong to the category whatever their namespace. */
  readonly frameTypes: readonly string[];
  /** Evidence data purposes that place an item in the category. */
  readonly dataPurposes: readonly string[];
}

/** The V0 catalog. Every entry is a declared rule, not a heuristic: a reader can
 * say which rule put an object in a view, and the same rule put it there for
 * every owner. */
export const CATEGORY_RULES: Readonly<Record<LifeCategory, CategoryRule>> = Object.freeze({
  FINANCE: Object.freeze({
    frameNamespaces: ['finance'],
    // An obligation is a debt in registry release 0.1.0: it carries a money
    // principal, and `obligations_projection` is its typed consumer.
    frameTypes: ['shared.obligation'],
    dataPurposes: ['PERSONAL_FINANCE', 'FINANCIAL_PLANNING', 'ANSWER_PERSONAL_FINANCE_QUESTION'],
  }),
  FAMILY: Object.freeze({
    frameNamespaces: ['family'],
    frameTypes: [],
    dataPurposes: ['FAMILY_COORDINATION', 'FAMILY_ADMINISTRATION', 'ANSWER_FAMILY_QUESTION'],
  }),
  WORK: Object.freeze({
    frameNamespaces: ['work'],
    frameTypes: [],
    dataPurposes: ['WORK_ASSISTANCE', 'PROJECT_TRACKING'],
  }),
  HEALTH: Object.freeze({
    frameNamespaces: ['health'],
    frameTypes: [],
    dataPurposes: ['HEALTH_ADMINISTRATION'],
  }),
  ADMIN: Object.freeze({
    frameNamespaces: ['admin'],
    frameTypes: [],
    dataPurposes: ['PERSONAL_ADMINISTRATION'],
  }),
  PERSONAL: Object.freeze({
    frameNamespaces: ['shared', 'personal'],
    frameTypes: [],
    dataPurposes: ['PERSONAL_ASSISTANCE'],
  }),
});

export const LIFE_CATEGORIES: readonly LifeCategory[] = Object.freeze(
  Object.keys(CATEGORY_RULES).map(name => lifeCategorySchema.parse(name)));

/** Every category one object belongs to, from the evidence behind it and the
 * frame it sits in. The answer is a set, never a single label: the whole point is
 * that an item can be in several views at once. */
export function deriveLifeCategories(input: {
  readonly frameTypeId?: string | null;
  readonly allowedPurposes?: readonly string[];
}): LifeCategory[] {
  const namespace = input.frameTypeId ? (input.frameTypeId.split('.')[0] ?? '') : '';
  const purposes = new Set(input.allowedPurposes ?? []);
  return LIFE_CATEGORIES.filter(category => {
    const rule = CATEGORY_RULES[category];
    if (input.frameTypeId && rule.frameTypes.includes(input.frameTypeId)) return true;
    if (namespace && rule.frameNamespaces.includes(namespace)) return true;
    return rule.dataPurposes.some(purpose => purposes.has(purpose));
  });
}

/** The category a declared request purpose selects, when it selects one. A
 * request may also name the view directly; this is the default so a caller that
 * declares `PERSONAL_FINANCE` does not have to say "finance" twice. */
export function categoryOfPurpose(purpose: string): LifeCategory | null {
  return LIFE_CATEGORIES.find(category => CATEGORY_RULES[category].dataPurposes.includes(purpose)) ?? null;
}

/** Whether an object with these derived categories belongs in the requested view.
 * A request that names no category asks for every view at once. */
export function inCategoryView(requested: LifeCategory | null, categories: readonly LifeCategory[]): boolean {
  return requested === null || categories.includes(requested);
}
