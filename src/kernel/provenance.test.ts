import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createClock, isRecordedAt } from "./clock.ts";
import { redactSecrets } from "./redaction.ts";
import { stampProvenance } from "./provenance.ts";

const SK_KEY = "sk-ant-api03-9fJ2kQ7xLmN4pR8sT1vW3yZ6bD0gH5jK";
const ANTHROPIC_VALUE = "aVeryPrivateAnthropicValue1234567890";
const OPENAI_VALUE = "anEntirelyDifferentOpenAiValue0987654321";
const BEARER_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";

/** One string per secret kind the redaction guard removes. */
const SECRET_BEARING = [
  `the fallback key is ${SK_KEY} and nothing else`,
  `ANTHROPIC_API_KEY=${ANTHROPIC_VALUE}`,
  `OPENAI_API_KEY=${OPENAI_VALUE}`,
  `curl -H "Authorization: Bearer ${BEARER_TOKEN}" https://api.example.com`,
];
const SECRET_VALUES = [SK_KEY, ANTHROPIC_VALUE, OPENAI_VALUE, BEARER_TOKEN];

const SOURCE = readFileSync(fileURLToPath(new URL("./provenance.ts", import.meta.url)), "utf8");

describe("stampProvenance shape", () => {
  it("answers exactly recordedAt, source and text", () => {
    const stamp = stampProvenance({ text: "a note", source: "chat/42" });

    expect(Object.keys(stamp).sort()).toEqual(["recordedAt", "source", "text"]);
    expect(stamp.text).toBe("a note");
    expect(stamp.source).toBe("chat/42");
  });

  it("stamps a recordedAt the clock recognizes", () => {
    const before = Date.now();
    const stamp = stampProvenance({ text: "a note", source: "chat/42" });
    const after = Date.now();

    expect(isRecordedAt(stamp.recordedAt)).toBe(true);
    expect(Date.parse(stamp.recordedAt)).toBeGreaterThanOrEqual(before - 1);
    expect(Date.parse(stamp.recordedAt)).toBeLessThanOrEqual(after);
  });

  it("takes its instant from the clock it is handed", () => {
    const clock = createClock(() => 1700000000123);
    const stamp = stampProvenance({ text: "a note", source: "chat/42" }, clock);

    expect(stamp.recordedAt).toBe("2023-11-14T22:13:20.123Z");
    expect(isRecordedAt(stamp.recordedAt)).toBe(true);
  });
});

describe("stampProvenance redaction", () => {
  it("removes a secret from text and from source, in every kind", () => {
    for (const text of SECRET_BEARING) {
      for (const source of SECRET_BEARING) {
        const stamp = stampProvenance({ text, source });

        // Exactly what the guard answers for the same input strings.
        expect(stamp.text).toBe(redactSecrets(text));
        expect(stamp.source).toBe(redactSecrets(source));
        expect(stamp.text).toContain("[REDACTED]");
        expect(stamp.source).toContain("[REDACTED]");

        for (const secret of SECRET_VALUES) {
          expect(stamp.text).not.toContain(secret);
          expect(stamp.source).not.toContain(secret);
        }
      }
    }
  });

  it("puts [REDACTED] exactly where the secret stood", () => {
    const stamp = stampProvenance({
      text: `ANTHROPIC_API_KEY=${ANTHROPIC_VALUE}`,
      source: `Authorization: Bearer ${BEARER_TOKEN}`,
    });

    expect(stamp.text).toBe("ANTHROPIC_API_KEY=[REDACTED]");
    expect(stamp.source).toBe("Authorization: Bearer [REDACTED]");
  });

  it("leaves secret-free fields byte-identical", () => {
    const text = "The task-list is risk-free; see docs/setup.md — ✓ 日本語 🔐";
    const source = "connector://email/thread-9?whisk-broom=1";
    const stamp = stampProvenance({ text, source });

    expect(stamp.text).toBe(text);
    expect(stamp.source).toBe(source);
  });

  it("refuses a non-string rather than coercing it into a stamp", () => {
    expect(() => stampProvenance({ text: undefined as unknown as string, source: "s" })).toThrow(
      TypeError,
    );
    expect(() => stampProvenance({ text: "t", source: { SK_KEY } as unknown as string })).toThrow(
      TypeError,
    );
  });
});

describe("provenance.ts composition", () => {
  it("imports both primitives from their one home", () => {
    expect(SOURCE).toMatch(/import\s*{[^}]*\brecordedAt\b[^}]*}\s*from\s*"\.\/clock\.ts"/);
    expect(SOURCE).toMatch(/import\s*{[^}]*\bredactSecrets\b[^}]*}\s*from\s*"\.\/redaction\.ts"/);
  });

  it("holds no second implementation of either primitive", () => {
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

    // No instant of its own: no Date, no ISO formatting, no date-to-string.
    for (const forbidden of [/\bDate\b/, /toISOString/, /toJSON/, /\bIntl\b/, /\d{4}-\d{2}-\d{2}/]) {
      expect(code).not.toMatch(forbidden);
    }
    // No secret-matching of its own: no pattern, no [REDACTED] literal, no key
    // names or auth scheme it would have to know to match on.
    for (const forbidden of [
      /new RegExp/,
      /\/[^/\n*][^\n]*\/[gimsuy]*\.(?:test|exec)\(/,
      /\.(?:replace|replaceAll|match|matchAll|search|split)\(/,
      /REDACTED/,
      /API_KEY/,
      /\bbearer\b/i,
      /sk-/,
    ]) {
      expect(code).not.toMatch(forbidden);
    }
  });
});
