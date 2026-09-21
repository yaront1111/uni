import { z } from 'zod';

/** Query restrictions, never evidence. Identity is resolved in the request's
 * owner scope. Due intervals are UTC instants, inclusive from / exclusive to.
 * Operator decision 4f30483d860ef242914fd93e6038cd35622f81029dfb3251e1a6a1508bbc3cf1. */
export const referenceQuerySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('UNRESOLVED') }),
  z.strictObject({
    kind: z.literal('OBLIGATION'),
    creditor: z.union([
      z.strictObject({ entityId: z.uuid() }),
      z.strictObject({ canonicalLabel: z.string().trim().min(1).max(256) }),
    ]),
    due: z.strictObject({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) })
      .refine(value => Date.parse(value.from) < Date.parse(value.to), 'Due interval must increase').optional(),
  }),
]);
export type ReferenceQuery = z.infer<typeof referenceQuerySchema>;
