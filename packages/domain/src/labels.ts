import { z } from 'zod';

/** PRD §24.5: how a material statement relates to what is known. The label decides
 * the wording; a contested value is never worded as certain and a scheduled one
 * never as having happened.
 *
 * Its own file so the Ask answer (`ask.ts`) and the grounding validator's
 * candidate statement (`answers.ts`) share one vocabulary without importing each
 * other. */
export const certaintyLabelSchema = z.enum(['CONFIRMED', 'REPORTED', 'INFERRED', 'CONFLICTING', 'UNKNOWN',
  'SCHEDULED', 'INTENDED', 'COMMITTED', 'PREDICTED', 'RECOMMENDED']);
export type CertaintyLabel = z.infer<typeof certaintyLabelSchema>;
