import { beforeEach, describe, expect, it } from "vitest";
import {
  captureNote,
  createNoteStore,
  listNotes,
  resetNotes,
  type Note,
} from "./note.ts";

// The module-level functions share one store, so each test starts from the
// state a fresh process is in: told nothing.
beforeEach(() => {
  resetNotes();
});

describe("capture", () => {
  it("crit-capture-returns-id-and-text: the captured note is returned and read back", () => {
    const note = captureNote("hello");

    expect(note.text).toBe("hello");
    expect(typeof note.id).toBe("string");
    expect(note.id.length).toBeGreaterThan(0);

    // "contains exactly that one record": one note, and it is that one.
    expect(listNotes()).toEqual([note]);
  });

  it("reads the same note back on every later listNotes", () => {
    const note = captureNote("hello");

    expect(listNotes()).toEqual([note]);
    expect(listNotes()).toEqual([note]);
  });

  it("keeps text byte for byte, including whitespace and unicode", () => {
    for (const text of ["  hello  ", "שלום", "line\nbreak", "\t", "🗒️ note"]) {
      resetNotes();
      expect(captureNote(text).text).toBe(text);
      expect(listNotes()[0]?.text).toBe(text);
    }
  });
});

describe("identity", () => {
  it("gives each note its own id, even for identical text", () => {
    const first = captureNote("hello");
    const second = captureNote("hello");

    expect(first.text).toBe(second.text);
    expect(first.id).not.toBe(second.id);
    expect(listNotes()).toEqual([first, second]);
  });

  it("does not derive the id from the text (identity is never a hash)", () => {
    const note = captureNote("hello");

    expect(note.id).not.toBe("hello");
    expect(note.id).not.toContain("hello");
  });

  it("keeps an id stable across reads", () => {
    const note = captureNote("hello");
    const id = note.id;

    captureNote("a later note");

    expect(note.id).toBe(id);
    expect(listNotes()[0]?.id).toBe(id);
  });
});

describe("listNotes", () => {
  it("is empty before anything is captured", () => {
    expect(listNotes()).toEqual([]);
  });

  it("returns notes oldest first", () => {
    const first = captureNote("first");
    const second = captureNote("second");
    const third = captureNote("third");

    expect(listNotes().map((n) => n.text)).toEqual(["first", "second", "third"]);
    expect(listNotes()).toEqual([first, second, third]);
  });

  it("hands back records a caller cannot mutate", () => {
    const note = captureNote("hello");

    // ES modules run in strict mode: assignment to a frozen field throws.
    expect(() => {
      (note as { text: string }).text = "tampered";
    }).toThrow(TypeError);
    expect(() => {
      (listNotes() as Note[]).push({ id: "smuggled", text: "smuggled" });
    }).toThrow(TypeError);

    expect(listNotes()).toEqual([{ id: note.id, text: "hello" }]);
  });
});

describe("refusals", () => {
  it("refuses an empty string", () => {
    expect(() => captureNote("")).toThrow(RangeError);
  });

  it("refuses a non-string", () => {
    expect(() => captureNote(undefined as unknown as string)).toThrow(TypeError);
    expect(() => captureNote(null as unknown as string)).toThrow(TypeError);
    expect(() => captureNote(42 as unknown as string)).toThrow(TypeError);
    expect(() => captureNote({ text: "hello" } as unknown as string)).toThrow(TypeError);
  });

  it("captures nothing when a call is refused", () => {
    const note = captureNote("hello");

    expect(() => captureNote("")).toThrow(RangeError);
    expect(() => captureNote(7 as unknown as string)).toThrow(TypeError);

    expect(listNotes()).toEqual([note]);
  });
});

describe("independent stores", () => {
  it("keeps one store's notes out of another's", () => {
    const a = createNoteStore();
    const b = createNoteStore();

    const inA = a.captureNote("hello");

    expect(a.listNotes()).toEqual([inA]);
    expect(b.listNotes()).toEqual([]);
    expect(listNotes()).toEqual([]);
  });
});
