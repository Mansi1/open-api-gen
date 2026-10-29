import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { emitCodecs } from "../src/emit/codecs.ts";
import { emitInterfaces } from "../src/emit/interfaces.ts";
import type { Files } from "../src/emit/layout.ts";
import { RUNTIME_SOURCES } from "../src/emit/runtime-sources.ts";
import { isUnsafeInteger, parseJson, settleUnsafeIntegers, stringifyJson } from "../src/emit/runtime/json.ts";
import * as transform from "../src/emit/runtime/transform.ts";
import * as validation from "../src/emit/runtime/validation.ts";
import { emitValidators } from "../src/emit/validators.ts";
import { buildIntermediateFormat } from "../src/intermediate-format/build.ts";
import { loadConfig, type ConfigInput } from "../src/intermediate-format/config.ts";
import type { IntermediateFormat } from "../src/intermediate-format/types.ts";
import { typeCheck } from "./support/type-check.ts";

const repositoryRoot = join(import.meta.dir, "..");

describe("runtime/json.ts", () => {
  test("parseJson keeps integers beyond 2^53 exact as markers, small numbers stay numbers", () => {
    const parsed = parseJson('{"big":9007199254740993,"small":42,"float":1.5,"list":[-9223372036854775808]}') as { big: unknown };
    expect(isUnsafeInteger(parsed.big)).toBe(true);
    expect(stringifyJson(parsed)).toBe('{"big":9007199254740993,"small":42,"float":1.5,"list":[-9223372036854775808]}');
    expect(settleUnsafeIntegers(parsed, BigInt)).toEqual({
      big: 9007199254740993n,
      small: 42,
      float: 1.5,
      list: [-9223372036854775808n],
    });
  });

  // Regression: every integer beyond 2^53 used to come back as bigint, also where the App type says number.
  test("settleUnsafeIntegers turns markers into numbers by default", () => {
    expect(settleUnsafeIntegers(parseJson('{"count":9007199254740993,"nested":[{"n":1e300}]}'))).toEqual({ count: 9007199254740992, nested: [{ n: 1e300 }] });
  });

  test("stringifyJson writes bigint as a plain JSON number", () => {
    expect(stringifyJson({ id: 9007199254740993n, nested: [1n], name: "x" })).toBe('{"id":9007199254740993,"nested":[1],"name":"x"}');
  });

  test("without JSON.rawJSON, safe bigints become numbers and unsafe ones fail loudly", () => {
    const jsonObject = JSON as unknown as { rawJSON?: unknown };
    const original = jsonObject.rawJSON;
    delete jsonObject.rawJSON;
    try {
      expect(stringifyJson({ id: 7n })).toBe('{"id":7}');
      expect(() => stringifyJson({ id: 9007199254740993n })).toThrow("no JSON.rawJSON");
    } finally {
      jsonObject.rawJSON = original;
    }
  });
});

describe("runtime/transform.ts", () => {
  test("date-time decodes to Date and encodes to ISO text", () => {
    const decoded = transform.dateTime.decode("2026-01-02T03:04:05Z", "/at") as Date;
    expect(decoded).toBeInstanceOf(Date);
    expect(transform.dateTime.encode(decoded, "/at")).toBe("2026-01-02T03:04:05.000Z");
    expect(() => transform.dateTime.decode("soon", "/at")).toThrow('/at: "soon" is not a valid date-time');
  });

  test("date is midnight UTC and round-trips as YYYY-MM-DD", () => {
    const decoded = transform.date.decode("2026-02-28", "") as Date;
    expect(decoded.toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(transform.date.encode(decoded, "")).toBe("2026-02-28");
    expect(() => transform.date.decode("2026-02-28T10:00:00Z", "/day")).toThrow("/day");
  });

  test("bigint accepts numbers and exact bigints, refuses rounded ones (the fallback without source text)", () => {
    expect(transform.bigint.decode(42, "")).toBe(42n);
    expect(transform.bigint.decode(9007199254740993n, "")).toBe(9007199254740993n);
    expect(() => transform.bigint.decode(9007199254740994, "/id")).toThrow("/id: 9007199254740994 lost precision");
  });

  test("object renames declared properties both ways and leaves undeclared keys alone", () => {
    const transformer = transform.object({ first_name: { appName: "firstName", transformer: transform.identity } });
    expect(transformer.decode({ first_name: "Ada", extra_key: 1 }, "")).toEqual({ firstName: "Ada", extra_key: 1 });
    expect(transformer.encode({ firstName: "Ada", extra_key: 1 }, "")).toEqual({ first_name: "Ada", extra_key: 1 });
  });

  test("union routes by wire validator, and by discriminator when there is one", () => {
    const withDate = transform.object({ at: { appName: "at", transformer: transform.dateTime } });
    const shape = transform.union([
      { validator: validation.object({ at: { required: true, validator: validation.string({ format: "date-time" }) } }), transformer: withDate },
      { validator: validation.nullValue, transformer: transform.identity },
    ]);
    expect(shape.decode(null, "")).toBeNull();
    expect((shape.decode({ at: "2026-01-02T03:04:05Z" }, "") as { at: Date }).at).toBeInstanceOf(Date);

    const tagged = transform.union([], { property: "kind", mapping: { Event: withDate } });
    expect((tagged.decode({ kind: "Event", at: "2026-01-02T03:04:05Z" }, "") as { at: Date }).at).toBeInstanceOf(Date);
  });
});

/** Stage 1 with a test config; every declaration is made runtime so each schema gets a codec. */
async function intermediateFormatWith(input: string, flags: ConfigInput): Promise<IntermediateFormat> {
  const built = await buildIntermediateFormat(await loadConfig(undefined, { input, output: "out", ...flags }));
  return { ...built, declarations: built.declarations.map((declaration) => ({ ...declaration, runtime: true })) };
}

/** Writes interfaces, validators, codecs, runtime and the hook module into tmp/generated/<name>/. */
function writeGenerated(intermediateFormat: IntermediateFormat, name: string): { directory: string; files: Files } {
  const files: Files = new Map([...emitInterfaces(intermediateFormat), ...emitValidators(intermediateFormat), ...emitCodecs(intermediateFormat), ...Object.entries(RUNTIME_SOURCES)]);
  const directory = join(repositoryRoot, "tmp", "generated", name);
  rmSync(directory, { recursive: true, force: true });
  for (const [path, content] of files) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  }
  mkdirSync(join(directory, "hooks"), { recursive: true });
  copyFileSync(join(import.meta.dir, "fixtures", "hooks", "decimal.ts"), join(directory, "hooks", "decimal.ts"));
  return { directory, files };
}

describe("emitted codecs", () => {
  test("snake_case + date-time + date + int64 round-trip through decode and encode", async () => {
    const intermediateFormat = await intermediateFormatWith("test/fixtures/features-3.1.json", { naming: { properties: "camelCase" } });
    const { directory } = writeGenerated(intermediateFormat, "codecs-snake");
    const { transformSnakeCase } = await import(join(directory, "interface/components/SnakeCase.codec.ts"));
    const wire = parseJson('{"first_name":"Ada","last_login_at":"2026-01-02T03:04:05.000Z","birth_date":"1815-12-10","balance_cents":9007199254740993,"labels":{"some_key":"kept"}}');

    const app = transformSnakeCase.decode(wire, "");
    expect(app).toEqual({
      firstName: "Ada",
      lastLoginAt: new Date("2026-01-02T03:04:05.000Z"),
      birthDate: new Date("1815-12-10T00:00:00Z"),
      balanceCents: 9007199254740993n,
      // Map keys are data, never renamed.
      labels: { some_key: "kept" },
    });
    const encoded = transformSnakeCase.encode(app, "");
    expect(stringifyJson(encoded)).toBe(stringifyJson(wire));
  });

  test("recursive and discriminated schemas convert at every level", async () => {
    const intermediateFormat = await intermediateFormatWith("test/fixtures/features-3.1.json", {});
    const { directory } = writeGenerated(intermediateFormat, "codecs-tree");
    const { transformGetTreesResponse } = await import(join(directory, "interface/response/GetTreesResponse.codec.ts"));
    const app = transformGetTreesResponse.decode({ root: { name: "a" }, meta: { generated_at: "2026-01-02T03:04:05.000Z" } }, "");
    expect(app.meta.generated_at).toBeInstanceOf(Date);
    expect(transformGetTreesResponse.encode(app, "")).toEqual({ root: { name: "a" }, meta: { generated_at: "2026-01-02T03:04:05.000Z" } });
  });

  test("format hook: int64 becomes the user's Decimal and back", async () => {
    const decimalHook = { type: "Decimal", import: "./hooks/decimal.ts", decode: "toDecimal", encode: "fromDecimal" };
    const intermediateFormat = await intermediateFormatWith("test/fixtures/features-3.1.json", { transformers: { "format:int64": decimalHook } });
    const { directory, files } = writeGenerated(intermediateFormat, "codecs-hook");
    expect(files.get("interface/components/SnakeCase.codec.ts")).toContain("import { fromDecimal, toDecimal } from '../../hooks/decimal.js';");
    expect(files.get("interface/app/SnakeCase.ts")).toContain("import type { Decimal } from '../../hooks/decimal.js';");
    const { transformSnakeCase } = await import(join(directory, "interface/components/SnakeCase.codec.ts"));
    // The generated code imports the hook copy inside the output directory, so compare with that class.
    const { Decimal: GeneratedDecimal } = await import(join(directory, "hooks/decimal.ts"));
    const app = transformSnakeCase.decode({ first_name: "Ada", balance_cents: 1234 }, "");
    expect(app.balance_cents).toBeInstanceOf(GeneratedDecimal);
    expect(app.balance_cents.digits).toBe("1234");
    expect(transformSnakeCase.encode(app, "")).toEqual({ first_name: "Ada", balance_cents: 1234n });
  });

  test("only transformed runtime declarations get a codec", async () => {
    const intermediateFormat = await intermediateFormatWith("test/fixtures/petstore-3.0.yaml", {});
    const paths = [...emitCodecs(intermediateFormat).keys()].sort();
    // Pet has created_at and id; NewPet, PetStatus and Error are unchanged by transforms.
    expect(paths).toEqual(["interface/components/Pet.codec.ts"]);
  });

  test("generated codecs type-check with interfaces, validators, runtime and hooks", async () => {
    const decimalHook = { type: "Decimal", import: "./hooks/decimal.ts", decode: "toDecimal", encode: "fromDecimal" };
    for (const [input, flags] of [
      ["test/fixtures/features-3.1.json", { naming: { properties: "camelCase" }, transformers: { "format:int64": decimalHook } }],
      ["test/fixtures/petstore-3.0.yaml", {}],
      ["examples/SpaceTraders.json", {}],
    ] as [string, ConfigInput][]) {
      const intermediateFormat = await intermediateFormatWith(input, flags);
      const { files } = writeGenerated(intermediateFormat, "codecs-typecheck");
      const hookSource = await Bun.file(join(import.meta.dir, "fixtures", "hooks", "decimal.ts")).text();
      expect({ input, diagnostics: typeCheck(files, `codecs-${input.split("/").pop()}`, { "hooks/decimal.ts": hookSource }) }).toEqual({ input, diagnostics: [] });
    }
  }, 60_000);
});
