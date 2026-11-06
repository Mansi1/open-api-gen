import { describe, expect, test } from "bun:test";
import { deref, resolve, UnsupportedRefError } from "../src/intermediate-format/refs.ts";

const document = {
  components: {
    schemas: {
      "a/b": { type: "string" },
      "tilde~name": { type: "number" },
      "with space": { type: "boolean" },
      Alias: { $ref: "#/components/schemas/Target" },
      Target: { type: "integer" },
      LoopFirst: { $ref: "#/components/schemas/LoopSecond" },
      LoopSecond: { $ref: "#/components/schemas/LoopFirst" },
    },
  },
  list: [{ id: 1 }],
};

describe("resolve", () => {
  test("decodes ~1, ~0 and percent-encoding", () => {
    expect(resolve(document, "#/components/schemas/a~1b")).toEqual({ type: "string" });
    expect(resolve(document, "#/components/schemas/tilde~0name")).toEqual({ type: "number" });
    expect(resolve(document, "#/components/schemas/with%20space")).toEqual({ type: "boolean" });
    expect(resolve(document, "#/list/0/id")).toBe(1);
    expect(resolve(document, "#")).toBe(document);
  });

  test("missing targets name the reference", () => {
    expect(() => resolve(document, "#/components/schemas/Nope")).toThrow('cannot resolve $ref "#/components/schemas/Nope"');
  });

  test("external references are unsupported", () => {
    expect(() => resolve(document, "other.yaml#/components/schemas/External")).toThrow(UnsupportedRefError);
    expect(() => resolve(document, "https://example.com/schema.json")).toThrow("URLs are not fetched");
  });
});

describe("deref", () => {
  test("follows chains and returns the final pointer", () => {
    expect(deref(document, { $ref: "#/components/schemas/Alias" })).toEqual({ value: { type: "integer" }, pointer: "/components/schemas/Target" });
    expect(deref(document, { type: "string" })).toEqual({ value: { type: "string" }, pointer: undefined });
  });

  test("detects reference loops", () => {
    expect(() => deref(document, { $ref: "#/components/schemas/LoopFirst" })).toThrow("$ref loop");
  });
});
