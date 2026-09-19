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

/** The uncertainty labels a reader sees on Today, Ask and the Why? / Sources
 * panel (design "uncertainty label system distinguishable without colour";
 * CRT-UX-12-A).
 *
 * It is the certainty vocabulary above seen from the memory's side: a contested
 * value reads CONTESTED, the owner's own unverified word reads
 * PENDING_OWNER_ASSERTION rather than merely "reported", and an outcome an
 * accepted resolution assertion settled reads RESOLVED. Each one has its own text
 * and its own glyph on screen, so none of them depends on colour. */
export const memoryLabelSchema = z.enum(['CONFIRMED', 'REPORTED', 'INFERRED', 'CONTESTED', 'PENDING_OWNER_ASSERTION',
  'SCHEDULED', 'RESOLVED', 'UNKNOWN', 'INTENDED', 'COMMITTED', 'PREDICTED', 'RECOMMENDED']);
export type MemoryLabel = z.infer<typeof memoryLabelSchema>;
