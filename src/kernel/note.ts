// Uai memory kernel — note capture.
//
// A note is the smallest thing Uai can be told: one piece of text, kept so it
// can be read back. Capture answers with the record it kept — id and text —
// and `listNotes` reads those records back in the order they were captured.
//
// The id is a surrogate one, minted by ../kernel/identities.ts (PRD section 3,
// "identity is never a hash"): a note's identity is never derived from its
// text, so capturing the same sentence twice keeps two distinct notes rather
// than collapsing them into one. This module holds no id minter of its own,
// for the reason provenance.ts holds no clock of its own — one place to fix.
//
// Text is kept byte for byte. Capture is a record of what it was told, not an
// editor: it does not trim, case-fold or otherwise normalize what it stores.

import { uuidV7 } from "./identities.ts";

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** An opaque surrogate id for a note. Never derived from the note's text. */
export type NoteId = string;

export interface Note {
  /** Stable and non-empty: it is the note's identity for as long as it is kept. */
  readonly id: NoteId;
  /** Exactly the text that was captured. */
  readonly text: string;
}

/** Seals a note: a caller holds a value it cannot use to reach into the store. */
function sealNote(note: Note): Note {
  return Object.freeze({ id: note.id, text: note.text });
}

/**
 * The one gate on what may be captured.
 *
 * @throws TypeError if `text` is not a string — capture is a record of what it
 * was told, and coercing a non-string would record something never said.
 * @throws RangeError if `text` is empty. Emptiness is length, not judgment: a
 * string of spaces is text someone typed, and is captured verbatim.
 */
function requireCapturableText(text: string): string {
  if (typeof text !== "string") {
    throw new TypeError(`captureNote: expected a string, received ${typeof text}`);
  }
  if (text.length === 0) {
    throw new RangeError("captureNote: expected a non-empty string, received \"\"");
  }
  return text;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface NoteStore {
  /** Keeps `text` as a fresh note and answers with the record it kept. */
  captureNote(text: string): Note;
  /** Every note kept by this store, oldest first. */
  listNotes(): readonly Note[];
  /** Forgets everything, so a test starts from a store that was told nothing. */
  resetNotes(): void;
}

/**
 * An independent store. Two stores never see each other's notes, which is how
 * a test gets an empty capture surface without disturbing the default one.
 */
export function createNoteStore(): NoteStore {
  let notes: readonly Note[] = Object.freeze([]);

  return {
    captureNote(text: string): Note {
      const note = sealNote({ id: uuidV7(), text: requireCapturableText(text) });
      notes = Object.freeze([...notes, note]);
      return note;
    },
    listNotes: () => notes,
    resetNotes() {
      notes = Object.freeze([]);
    },
  };
}

/**
 * The store the module-level functions below capture into. It starts empty, so
 * the first `captureNote` of a process is followed by a `listNotes` holding
 * exactly that one note.
 */
const defaultStore = createNoteStore();

/**
 * Captures `text` as a note and answers with the record kept: a non-empty
 * surrogate `id` and the text exactly as given. The returned record is frozen,
 * and is the same record a following `listNotes()` reads back.
 *
 * @throws TypeError if `text` is not a string.
 * @throws RangeError if `text` is empty. Nothing is captured when either
 * refusal fires — a refused call leaves the store exactly as it was.
 */
export function captureNote(text: string): Note {
  return defaultStore.captureNote(text);
}

/** Every note captured into the default store, oldest first. */
export function listNotes(): readonly Note[] {
  return defaultStore.listNotes();
}

/** Forgets every note in the default store. */
export function resetNotes(): void {
  defaultStore.resetNotes();
}
