import { describe, expect, it } from "vitest";

import { matchesExpectedState } from "./object.js";

describe("matchesExpectedState", () => {
  describe("exact matches", () => {
    it("returns true for matching flat objects", () => {
      expect(
        matchesExpectedState(
          { a: "hello", b: 42, c: true },
          { a: "hello", b: 42, c: true },
        ),
      ).toBe(true);
    });

    it("returns true when expected is empty (vacuously true)", () => {
      expect(matchesExpectedState({}, { a: 1, b: "anything" })).toBe(true);
    });

    it("returns true when current has extra keys (subset check)", () => {
      expect(matchesExpectedState({ a: 1 }, { a: 1, b: 2, c: 3 })).toBe(true);
    });
  });

  describe("value mismatches", () => {
    it("returns false when a string value differs", () => {
      expect(matchesExpectedState({ a: "hello" }, { a: "world" })).toBe(false);
    });

    it("returns false when a number value differs", () => {
      expect(matchesExpectedState({ a: 1 }, { a: 2 })).toBe(false);
    });

    it("returns false when a boolean value differs", () => {
      expect(matchesExpectedState({ a: true }, { a: false })).toBe(false);
    });

    it("returns false when expected key is missing from current", () => {
      expect(matchesExpectedState({ a: 1 }, { b: 1 })).toBe(false);
    });
  });

  describe("null handling", () => {
    it("returns true when both values are null", () => {
      expect(matchesExpectedState({ a: null }, { a: null })).toBe(true);
    });

    it("returns false when expected is null but current is not", () => {
      expect(matchesExpectedState({ a: null }, { a: "something" })).toBe(false);
    });

    it("returns false when expected is not null but current is null", () => {
      expect(matchesExpectedState({ a: "something" }, { a: null })).toBe(false);
    });
  });

  describe("nested objects", () => {
    it("returns true when nested objects match", () => {
      expect(
        matchesExpectedState(
          { nested: { x: 1, y: "two" } },
          { nested: { x: 1, y: "two", z: 3 } },
        ),
      ).toBe(true);
    });

    it("returns false when a deeply nested value differs", () => {
      expect(
        matchesExpectedState(
          { nested: { deep: { value: 1 } } },
          { nested: { deep: { value: 2 } } },
        ),
      ).toBe(false);
    });

    it("returns false when expected has nested object but current has null", () => {
      expect(matchesExpectedState({ nested: { x: 1 } }, { nested: null })).toBe(
        false,
      );
    });

    it("returns false when expected has nested object but current has array", () => {
      expect(
        matchesExpectedState({ nested: { x: 1 } }, { nested: [1, 2] }),
      ).toBe(false);
    });

    it("returns false when expected has nested object but current has primitive", () => {
      expect(matchesExpectedState({ nested: { x: 1 } }, { nested: 42 })).toBe(
        false,
      );
    });
  });

  describe("array handling", () => {
    it("returns true for matching arrays of primitives", () => {
      expect(matchesExpectedState({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    });

    it("returns true for same array reference", () => {
      const arr = [1, 2, 3];
      expect(matchesExpectedState({ a: arr }, { a: arr })).toBe(true);
    });

    it("returns false when array lengths differ", () => {
      expect(matchesExpectedState({ a: [1, 2] }, { a: [1] })).toBe(false);
    });

    it("returns false when array elements differ", () => {
      expect(matchesExpectedState({ a: [1, 2] }, { a: [1, 3] })).toBe(false);
    });

    it("returns true for matching arrays of objects", () => {
      expect(
        matchesExpectedState(
          { subs: [{ amount: 100, cat: "a" }] },
          { subs: [{ amount: 100, cat: "a" }] },
        ),
      ).toBe(true);
    });

    it("returns false for arrays of objects with mismatched values", () => {
      expect(
        matchesExpectedState(
          { subs: [{ amount: 100 }] },
          { subs: [{ amount: 200 }] },
        ),
      ).toBe(false);
    });

    it("returns false when expected has array but current has object", () => {
      expect(matchesExpectedState({ a: [1, 2] }, { a: { 0: 1, 1: 2 } })).toBe(
        false,
      );
    });

    it("returns false when expected has object but current has array", () => {
      expect(matchesExpectedState({ a: { x: 1 } }, { a: [1] })).toBe(false);
    });
  });
});
