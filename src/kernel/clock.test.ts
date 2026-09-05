import { describe, expect, it } from "vitest";
import { createClock, isRecordedAt, recordedAt } from "./clock.ts";

const RECORDED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("recordedAt", () => {
  it("answers the current instant in the recorded shape", () => {
    const before = Date.now();
    const stamp = recordedAt();
    const after = Date.now();

    expect(typeof stamp).toBe("string");
    expect(stamp).toMatch(RECORDED_AT);
    expect(Date.parse(stamp)).toBeGreaterThanOrEqual(before - 1);
    expect(Date.parse(stamp)).toBeLessThanOrEqual(after);
  });

  it("advances with the wall clock", async () => {
    const first = recordedAt();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(Date.parse(recordedAt())).toBeGreaterThanOrEqual(Date.parse(first));
  });
});

describe("createClock", () => {
  it("answers the instant its millisecond source names, every call", () => {
    const clock = createClock(() => 1700000000123);

    expect(clock.recordedAt()).toBe("2023-11-14T22:13:20.123Z");
    expect(clock.recordedAt()).toBe(clock.recordedAt());
    expect(isRecordedAt(clock.recordedAt())).toBe(true);
  });

  it("consults its source per call and never the wall clock", () => {
    let ticks = 0;
    const clock = createClock(() => 1700000000000 + ticks++);

    expect(clock.recordedAt()).toBe("2023-11-14T22:13:20.000Z");
    expect(clock.recordedAt()).toBe("2023-11-14T22:13:20.001Z");
    expect(clock.recordedAt()).toBe("2023-11-14T22:13:20.002Z");
    expect(ticks).toBe(3);
  });

  it("carries the same predicate as the module-level clock", () => {
    const clock = createClock(() => 0);

    expect(clock.recordedAt()).toBe("1970-01-01T00:00:00.000Z");
    expect(clock.isRecordedAt(clock.recordedAt())).toBe(true);
    expect(clock.isRecordedAt("1970-01-01T00:00:00Z")).toBe(false);
  });

  it("refuses a source that answers an unrepresentable instant", () => {
    expect(() => createClock(() => Number.NaN).recordedAt()).toThrow(RangeError);
    expect(() => createClock(() => Number.POSITIVE_INFINITY).recordedAt()).toThrow(RangeError);
    expect(() => createClock(() => 8.64e15 + 1).recordedAt()).toThrow(RangeError);
    // Representable as a Date, but renders with an expanded year.
    expect(() => createClock(() => 8.64e15).recordedAt()).toThrow(RangeError);
  });

  it("refuses a source that is not a function", () => {
    expect(() => createClock(undefined as never)).toThrow(TypeError);
  });
});

describe("isRecordedAt", () => {
  it("accepts what recordedAt produces", () => {
    expect(isRecordedAt(recordedAt())).toBe(true);
    expect(isRecordedAt(createClock(() => 1700000000123).recordedAt())).toBe(true);
    expect(isRecordedAt("2023-11-14T22:13:20.123Z")).toBe(true);
  });

  it("rejects non-strings", () => {
    for (const value of [
      undefined,
      null,
      1700000000123,
      true,
      {},
      [],
      new Date(1700000000123),
      Symbol("2023-11-14T22:13:20.123Z"),
    ]) {
      expect(isRecordedAt(value)).toBe(false);
    }
  });

  it("rejects the empty string", () => {
    expect(isRecordedAt("")).toBe(false);
    expect(isRecordedAt("   ")).toBe(false);
  });

  it("rejects date-times lacking millisecond precision", () => {
    expect(isRecordedAt("2023-11-14T22:13:20Z")).toBe(false);
    expect(isRecordedAt("2023-11-14T22:13Z")).toBe(false);
    expect(isRecordedAt("2023-11-14T22:13:20.1Z")).toBe(false);
    expect(isRecordedAt("2023-11-14T22:13:20.12Z")).toBe(false);
    expect(isRecordedAt("2023-11-14T22:13:20.123456Z")).toBe(false);
    expect(isRecordedAt("2023-11-14")).toBe(false);
  });

  it("rejects date-times lacking the Z designator", () => {
    expect(isRecordedAt("2023-11-14T22:13:20.123")).toBe(false);
    expect(isRecordedAt("2023-11-14T22:13:20.123+00:00")).toBe(false);
    expect(isRecordedAt("2023-11-14T22:13:20.123+02:00")).toBe(false);
    expect(isRecordedAt("2023-11-14T22:13:20.123z")).toBe(false);
    expect(isRecordedAt("2023-11-14 22:13:20.123Z")).toBe(false);
  });

  it("rejects well-shaped strings that name no real instant", () => {
    expect(isRecordedAt("2023-02-30T00:00:00.000Z")).toBe(false);
    expect(isRecordedAt("2023-13-01T00:00:00.000Z")).toBe(false);
    expect(isRecordedAt("2023-11-14T24:00:00.000Z")).toBe(false);
    expect(isRecordedAt("2023-11-14T22:60:00.000Z")).toBe(false);
    expect(isRecordedAt("not-a-timestamp")).toBe(false);
  });
});
