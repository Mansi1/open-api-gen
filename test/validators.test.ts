import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { registerSchema, validate as validateWithOracle } from "@hyperjump/json-schema/draft-2020-12";
import { emitInterfaces } from "../src/emit/interfaces.ts";
import type { Files } from "../src/emit/layout.ts";
import { RUNTIME_SOURCES } from "../src/emit/runtime-sources.ts";
import * as runtime from "../src/emit/runtime/validation.ts";
import { emitValidators } from "../src/emit/validators.ts";
import type { IntermediateFormat } from "../src/intermediate-format/types.ts";
import { typeCheck } from "./support/type-check.ts";

const repositoryRoot = join(import.meta.dir, "..");
const readGoldenIntermediateFormat = (name: string): IntermediateFormat => JSON.parse(readFileSync(join(import.meta.dir, "golden", "intermediate-format", `${name}.json`), "utf8"));
const issuesOf = (validator: runtime.Validator, value: unknown) => runtime.validate(validator, value);

describe("runtime/validation.ts keywords", () => {
  test.each<[string, runtime.Validator, unknown[], unknown[]]>([
    ["string", runtime.string(), ["", "text"], [1, null, {}]],
    ["minLength counts code points", runtime.string({ minLength: 2 }), ["ab", "😀😀"], ["a", "😀"]],
    ["maxLength", runtime.string({ maxLength: 1 }), ["", "😀"], ["ab"]],
    ["pattern", runtime.string({ pattern: "^[a-z]+$" }), ["abc"], ["ABC", "a1"]],
    ["date-time", runtime.string({ format: "date-time" }), ["2026-01-02T03:04:05Z", "2026-01-02T03:04:05.123+02:00"], ["2026-01-02", "yesterday", "2026-13-02T03:04:05Z"]],
    ["date", runtime.string({ format: "date" }), ["2026-01-02"], ["2026-01-02T00:00:00Z", "2026-02-30x"]],
    ["other formats are annotations", runtime.string({ format: "uuid" }), ["not-a-uuid"], []],
    ["integer", runtime.number(true), [1, -3, 2n], [1.5, "1", Number.NaN]],
    ["number bounds", runtime.number(false, { minimum: 1, maximum: 3 }), [1, 3, 2.5], [0.9, 3.1]],
    ["exclusive bounds", runtime.number(false, { exclusiveMinimum: 0, exclusiveMaximum: 1 }), [0.5], [0, 1]],
    ["multipleOf with floats", runtime.number(false, { multipleOf: 0.1 }), [0.3, 1], [0.35]],
    ["boolean", runtime.boolean, [true, false], [0, "true"]],
    ["null", runtime.nullValue, [null], [undefined, 0]],
    ["literal", runtime.literal("Circle"), ["Circle"], ["Square"]],
    ["enum", runtime.oneOfValues(["a", null]), ["a", null], ["b"]],
    ["array", runtime.array(runtime.number(true), { minItems: 1, uniqueItems: true }), [[1], [1, 2]], [[], [1, 1], ["x"], {}]],
    ["uniqueItems ignores key order", runtime.array(runtime.anything, { uniqueItems: true }), [[{ a: 1 }, { a: 2 }]], [[{ a: 1, b: 2 }, { b: 2, a: 1 }]]],
    ["closed tuple", runtime.tuple([runtime.number(false), runtime.number(false)], false), [[1, 2], [1]], [[1, 2, 3], ["x", 2]]],
    ["open tuple", runtime.tuple([runtime.string()], null), [["a", 1, {}]], [[1]]],
    ["required and closed object", runtime.object({ id: { required: true, validator: runtime.string() } }, false), [{ id: "x" }], [{}, { id: 1 }, { id: "x", extra: 1 }, []]],
    ["map", runtime.object({}, runtime.string()), [{}, { key: "value" }], [{ key: 1 }]],
    ["allOf", runtime.allOf([runtime.number(false, { minimum: 0 }), runtime.number(false, { maximum: 10 })]), [5], [-1, 11]],
    ["anyOf", runtime.anyOf([runtime.string(), runtime.nullValue]), ["x", null], [1]],
    ["oneOf counts matches", runtime.oneOf([runtime.number(false), runtime.number(true)]), [1.5], [1, "x"]],
    ["unknown accepts everything", runtime.anything, [1, null, {}, "x"], []],
    ["never rejects everything", runtime.nothing, [], [1, null]],
  ])("%s", (_keyword, validator, accepted, rejected) => {
    for (const value of accepted) {
      expect({ value, issues: issuesOf(validator, value) }).toEqual({ value, issues: [] });
    }
    for (const value of rejected) {
      expect(issuesOf(validator, value).length).toBeGreaterThan(0);
    }
  });

  test("issues carry JSON Pointer paths", () => {
    const validator = runtime.object({ "a/b": { required: true, validator: runtime.array(runtime.string()) } });
    expect(issuesOf(validator, { "a/b": ["ok", 7] })).toEqual([{ path: "/a~1b/1", message: "must be a string, got number" }]);
  });

  test("discriminator dispatches directly and reports a bad tag", () => {
    const circle = runtime.object({ kind: { required: true, validator: runtime.literal("Circle") }, radius: { required: true, validator: runtime.number(false) } });
    const validator = runtime.oneOf([circle], { property: "kind", mapping: { Circle: circle } });
    expect(issuesOf(validator, { kind: "Circle", radius: 1 })).toEqual([]);
    expect(issuesOf(validator, { kind: "Hexagon" })).toEqual([{ path: "/kind", message: 'must be one of "Circle"' }]);
  });
});

/** Writes generated files plus the runtime into tmp/<name>/ and imports one generated module. */
async function importGenerated(files: Files, name: string, modulePath: string): Promise<Record<string, runtime.Validator>> {
  const directory = join(repositoryRoot, "tmp", "generated", name);
  rmSync(directory, { recursive: true, force: true });
  for (const [path, content] of [...files, ...Object.entries(RUNTIME_SOURCES)]) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  }
  return import(join(directory, modulePath));
}

describe("emitted validators", () => {
  test("only runtime declarations get a validator, next to their type", () => {
    const intermediateFormat = readGoldenIntermediateFormat("features-3.1");
    const paths = [...emitValidators(intermediateFormat).keys()].sort();
    expect(paths).toEqual([
      "interface/components/Circle.validate.ts",
      "interface/components/Shape.validate.ts",
      "interface/components/Square.validate.ts",
      "interface/components/TreeNode.validate.ts",
      "interface/request/PutUntaggedRequest.validate.ts",
      "interface/response/GetTreesResponse.validate.ts",
      "interface/response/GetTreesResponseMeta.validate.ts",
    ]);
  });

  test("recursive TreeNode and discriminated Shape run", async () => {
    const intermediateFormat = readGoldenIntermediateFormat("features-3.1");
    const files = emitValidators(intermediateFormat);
    const { validateTreeNode } = await importGenerated(files, "features-tree", "interface/components/TreeNode.validate.ts");
    const { validateShape } = await importGenerated(files, "features-shape", "interface/components/Shape.validate.ts");
    expect(runtime.validate(validateTreeNode!, { name: "root", children: [{ name: "leaf", parent: null }] })).toEqual([]);
    expect(runtime.validate(validateTreeNode!, { name: "root", children: [{ children: [] }] })).toEqual([{ path: "/children/0/name", message: "is required" }]);
    expect(runtime.validate(validateShape!, { kind: "Square", side: 2 })).toEqual([]);
    expect(runtime.validate(validateShape!, { kind: "Square", side: 2, extra: true })).toEqual([{ path: "/extra", message: "is not allowed" }]);
  });

  test("emitted validators and interfaces type-check together", () => {
    for (const name of ["petstore-3.0", "features-3.1", "features-3.2", "SpaceTraders", "petstore-api"]) {
      const intermediateFormat = readGoldenIntermediateFormat(name);
      const files: Files = new Map([...emitInterfaces(intermediateFormat), ...emitValidators(intermediateFormat), ...Object.entries(RUNTIME_SOURCES)]);
      expect({ name, diagnostics: typeCheck(files, `validators-${name}`) }).toEqual({ name, diagnostics: [] });
    }
  });
});

describe("oracle: emitted validators agree with @hyperjump/json-schema", () => {
  // The features fixture as a plain JSON Schema 2020-12 document: components.schemas become $defs.
  const document = JSON.parse(readFileSync(join(repositoryRoot, "test/fixtures/features-3.1.json"), "utf8"));
  const definitionsText = JSON.stringify(document.components.schemas).replaceAll("#/components/schemas/", "#/$defs/");
  registerSchema({ $schema: "https://json-schema.org/draft/2020-12/schema", $id: "https://open-api-gen.local/features", $defs: JSON.parse(definitionsText) });

  const samples: Record<string, unknown[]> = {
    Shape: [{ kind: "Circle", radius: 1 }, { kind: "Circle", radius: -1 }, { kind: "Square", side: 1 }, { kind: "Square", side: 1, extra: 1 }, { kind: "Square" }],
    TreeNode: [{ name: "a" }, { name: "a", children: [{ name: "b", parent: null }] }, { name: 1 }, { children: [] }, { name: "a", parent: { name: 2 } }],
    Labels: [{}, { key: "value" }, { key: 1 }, []],
    Point: [[1, 2], [1], [1, 2, 3], ["1", 2]],
    Nullable: [1, null, 1.5, "1"],
    SnakeCase: [{ first_name: "Ada" }, { first_name: "Ada", last_login_at: "2026-01-02T03:04:05Z" }, {}, { first_name: "Ada", balance_cents: 1.5 }],
  };

  for (const [schemaName, values] of Object.entries(samples)) {
    test(`${schemaName}`, async () => {
      const intermediateFormat = readGoldenIntermediateFormat("features-3.1");
      // Every declaration gets a validator here, not only runtime ones, so each sample schema can be checked.
      const allRuntime: IntermediateFormat = { ...intermediateFormat, declarations: intermediateFormat.declarations.map((declaration) => ({ ...declaration, runtime: true })) };
      const generated = await importGenerated(emitValidators(allRuntime), `oracle-${schemaName}`, `interface/components/${schemaName}.validate.ts`);
      const ours = generated[`validate${schemaName}`]!;
      for (const value of values) {
        const oracle = await validateWithOracle(`https://open-api-gen.local/features#/$defs/${schemaName}`, value as never);
        // The oracle does not assert formats by default; our date-time check is stricter only for malformed dates.
        expect({ value, valid: runtime.validate(ours, value).length === 0 }).toEqual({ value, valid: oracle.valid });
      }
    });
  }
});
