import { z } from 'zod';
import { RegistryError, type LoadedRegistryRelease } from './release.js';
import type { PredicateContract } from './schema.js';

const text = z.string().trim().min(1).max(4000);
const instant = z.iso.datetime({ offset: true });
const reference = z.strictObject({ system: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/), id: z.string().min(1).max(512) });

/** Money keeps its exact decimal string; the registry library performs no arithmetic. */
const money = z.strictObject({
  amount: z.string().regex(/^(0|[1-9]\d{0,17})(\.\d{1,6})?$/).refine(amount => /[1-9]/.test(amount)),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

const valueSchemas: Record<PredicateContract['valueType'], z.ZodType> = {
  MONEY: money,
  TEXT: text,
  TIMESTAMP: instant,
  TIME_OR_INTERVAL: z.union([instant, z.strictObject({ start: instant, end: instant })
    .refine(interval => Date.parse(interval.start) <= Date.parse(interval.end))]),
  ENTITY: z.uuid(),
  FRAME_REFERENCE: z.uuid(),
  EXTERNAL_REFERENCE: reference,
  ACTION: z.union([text, z.strictObject({ frameInstanceId: z.uuid() })]),
};

export function findPredicate(release: Pick<LoadedRegistryRelease, 'frames'>, predicateId: string): PredicateContract | undefined {
  return release.frames.flatMap(frame => frame.predicates).find(predicate => predicate.id === predicateId);
}

/** Validates a candidate value against its registered predicate value type. */
export function validatePredicateValue(release: Pick<LoadedRegistryRelease, 'frames'>, predicateId: string, value: unknown): unknown {
  const predicate = findPredicate(release, predicateId);
  if (!predicate) throw new RegistryError('REGISTRY_PREDICATE_UNKNOWN');
  const parsed = valueSchemas[predicate.valueType].safeParse(value);
  if (!parsed.success) throw new RegistryError('REGISTRY_VALUE_INVALID');
  return parsed.data;
}
