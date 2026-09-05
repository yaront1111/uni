import { afterEach, describe, expect, it, vi } from "vitest";
import { redactSecrets } from "./redaction.ts";

const SK_KEY = "sk-ant-api03-9fJ2kQ7xLmN4pR8sT1vW3yZ6bD0gH5jK";
const ANTHROPIC_VALUE = "aVeryPrivateAnthropicValue1234567890";
const OPENAI_VALUE = "anEntirelyDifferentOpenAiValue0987654321";
const BEARER_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";

const ALL_FOUR = [
  `curl -H "Authorization: Bearer ${BEARER_TOKEN}" https://api.example.com/v1/messages`,
  `ANTHROPIC_API_KEY=${ANTHROPIC_VALUE}`,
  `OPENAI_API_KEY=${OPENAI_VALUE}`,
  `the fallback key is ${SK_KEY} and nothing else`,
].join("\n");

describe("redactSecrets", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("replaces every kind of secret with [REDACTED] and keeps none of the values", () => {
    const redacted = redactSecrets(ALL_FOUR);

    for (const secret of [SK_KEY, ANTHROPIC_VALUE, OPENAI_VALUE, BEARER_TOKEN]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted.match(/\[REDACTED\]/g)).toHaveLength(4);
  });

  it("keeps the key name of an assignment and replaces only its value", () => {
    expect(redactSecrets(`ANTHROPIC_API_KEY=${ANTHROPIC_VALUE}`)).toBe(
      "ANTHROPIC_API_KEY=[REDACTED]",
    );
    expect(redactSecrets(`OPENAI_API_KEY=${OPENAI_VALUE}`)).toBe("OPENAI_API_KEY=[REDACTED]");
    expect(redactSecrets(`export OPENAI_API_KEY="${OPENAI_VALUE}"`)).toBe(
      'export OPENAI_API_KEY="[REDACTED]"',
    );
  });

  it("keeps the header name and scheme of an authorization line", () => {
    expect(redactSecrets(`Authorization: Bearer ${BEARER_TOKEN}`)).toBe(
      "Authorization: Bearer [REDACTED]",
    );
    expect(redactSecrets(`authorization: bearer ${BEARER_TOKEN}`)).toBe(
      "authorization: bearer [REDACTED]",
    );
  });

  it("removes an sk- key wherever it appears, including inside other secrets", () => {
    expect(redactSecrets(SK_KEY)).toBe("[REDACTED]");
    expect(redactSecrets(`{"apiKey": "${SK_KEY}"}`)).toBe('{"apiKey": "[REDACTED]"}');
    // The enclosing rule wins; the sk- rule gets no second bite at a gone value.
    expect(redactSecrets(`ANTHROPIC_API_KEY=${SK_KEY}`)).toBe("ANTHROPIC_API_KEY=[REDACTED]");
    expect(redactSecrets(`Authorization: Bearer ${SK_KEY}`)).toBe(
      "Authorization: Bearer [REDACTED]",
    );
  });

  it("redacts every occurrence, not just the first", () => {
    const redacted = redactSecrets(`${SK_KEY} ${SK_KEY} ${SK_KEY}`);
    expect(redacted).toBe("[REDACTED] [REDACTED] [REDACTED]");
  });

  it("returns byte-identical text when no secret is present", () => {
    const clean = [
      "The task-list is risk-free and the whisk-broom is put away.",
      'GET /v1/models HTTP/1.1\r\nAccept: application/json\r\n\r\n{"ok":true}',
      "ANTHROPIC_API_KEY is read from the environment; see docs/setup.md.",
      "Authorization is decided by policy, not by this module.",
      "unicode: ✓ 日本語 — emoji 🔐 — tabs\tand\ttrailing spaces   ",
      "",
    ].join("\n");

    const redacted = redactSecrets(clean);
    expect(redacted).toBe(clean);
    expect(Buffer.from(redacted, "utf8").equals(Buffer.from(clean, "utf8"))).toBe(true);
  });

  it("writes nothing to any console or stdout sink while removing a secret", () => {
    const sinks = ["log", "info", "warn", "error", "debug", "trace"] as const;
    const spies = sinks.map((sink) => vi.spyOn(console, sink).mockImplementation(() => {}));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    redactSecrets(ALL_FOUR);

    for (const spy of [...spies, stdout, stderr]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("leaves no length hint: secrets of different lengths leave identical residue", () => {
    const short = redactSecrets("key=sk-a\nAuthorization: Bearer b");
    const long = redactSecrets(
      `key=${SK_KEY}${SK_KEY}\nAuthorization: Bearer ${BEARER_TOKEN}${BEARER_TOKEN}`,
    );

    expect(short).toBe(long);
    expect(short).toBe("key=[REDACTED]\nAuthorization: Bearer [REDACTED]");
  });

  it("leaves no residue of the secret in its output", () => {
    const redacted = redactSecrets(`ANTHROPIC_API_KEY=${ANTHROPIC_VALUE}`);
    const body = redacted.replace("[REDACTED]", "");

    // Nothing of the value survives — not a character of it, in any casing,
    // reversed, or in any common encoding.
    for (const shape of [
      ANTHROPIC_VALUE,
      ANTHROPIC_VALUE.toLowerCase(),
      [...ANTHROPIC_VALUE].reverse().join(""),
      Buffer.from(ANTHROPIC_VALUE, "utf8").toString("base64"),
      Buffer.from(ANTHROPIC_VALUE, "utf8").toString("hex"),
    ]) {
      expect(redacted).not.toContain(shape);
    }
    for (const character of new Set(ANTHROPIC_VALUE)) {
      expect(body.includes(character)).toBe("ANTHROPIC_API_KEY=".includes(character));
    }
  });

  it("rejects a non-string rather than coercing it", () => {
    expect(() => redactSecrets(undefined as unknown as string)).toThrow(TypeError);
    expect(() => redactSecrets({ key: SK_KEY } as unknown as string)).toThrow(TypeError);
  });
});
