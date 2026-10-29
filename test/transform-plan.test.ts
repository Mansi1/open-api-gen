import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig, type ConfigInput } from "../src/intermediate-format/config.ts";
import { load } from "../src/intermediate-format/load.ts";
import { normalize } from "../src/intermediate-format/normalize.ts";
import { planTransforms } from "../src/intermediate-format/transform-plan.ts";
import type { Declaration, IntermediateFormat, Property } from "../src/intermediate-format/types.ts";

const repositoryRoot = join(import.meta.dir, "..");

async function plannedIr(path: string, flags: ConfigInput = {}): Promise<IntermediateFormat> {
  const { document, version } = await load(join(repositoryRoot, path));
  const config = await loadConfig(undefined, { input: path, output: "out", ...flags });
  return planTransforms(normalize(document, version, path), config);
}

function declarationOf(intermediateFormat: IntermediateFormat, name: string): Declaration {
  return intermediateFormat.declarations.find((declaration) => declaration.name === name)!;
}

function propertyOf(intermediateFormat: IntermediateFormat, declarationName: string, propertyName: string): Property {
  const type = declarationOf(intermediateFormat, declarationName).type;
  if (type.kind !== "object") {
    throw new Error(`${declarationName} is ${type.kind}`);
  }
  return type.properties.find((property) => property.name === propertyName)!;
}

describe("T1 formats", () => {
  test("date-time, date and int64 get codecs by default", async () => {
    const intermediateFormat = await plannedIr("test/fixtures/features-3.1.json");
    expect(propertyOf(intermediateFormat, "SnakeCase", "last_login_at").type.codec).toEqual({ kind: "date-time" });
    expect(propertyOf(intermediateFormat, "SnakeCase", "birth_date").type.codec).toEqual({ kind: "date" });
    expect(propertyOf(intermediateFormat, "SnakeCase", "balance_cents").type.codec).toEqual({ kind: "bigint" });
    expect(propertyOf(intermediateFormat, "SnakeCase", "first_name").type.codec).toBeUndefined();
  });

  test("int64 inside a 3.1 type array gets the codec on the integer member only", async () => {
    const type = declarationOf(await plannedIr("test/fixtures/features-3.1.json"), "Nullable").type;
    if (type.kind !== "union") {
      throw new Error(`expected a union, got ${type.kind}`);
    }
    expect(type.members.map((member) => member.codec)).toEqual([{ kind: "bigint" }, undefined]);
  });

  test("config opts out per format", async () => {
    const intermediateFormat = await plannedIr("test/fixtures/features-3.1.json", { formats: { "date-time": "string", int64: "number" } });
    expect(propertyOf(intermediateFormat, "SnakeCase", "last_login_at").type.codec).toBeUndefined();
    expect(propertyOf(intermediateFormat, "SnakeCase", "balance_cents").type.codec).toBeUndefined();
    expect(propertyOf(intermediateFormat, "SnakeCase", "birth_date").type.codec).toEqual({ kind: "date" });
  });

  test("parameters keep wire types", async () => {
    const intermediateFormat = await plannedIr("test/fixtures/petstore-3.0.yaml");
    const getPet = intermediateFormat.services[0]!.operations.find((operation) => operation.name === "getPet")!;
    expect(getPet.parameters.path?.parameters[0]?.type.codec).toBeUndefined();
    expect(declarationOf(intermediateFormat, "GetPetPathParameter").transformed).toBe(false);
  });
});

describe("T2 naming", () => {
  test("camelCase renames properties, not map keys", async () => {
    const intermediateFormat = await plannedIr("test/fixtures/features-3.1.json", { naming: { properties: "camelCase" } });
    expect(propertyOf(intermediateFormat, "SnakeCase", "first_name").appName).toBe("firstName");
    expect(propertyOf(intermediateFormat, "SnakeCase", "labels").appName).toBe("labels");
    const labels = declarationOf(intermediateFormat, "Labels").type;
    if (labels.kind !== "object") {
      throw new Error(`expected an object, got ${labels.kind}`);
    }
    expect(labels.properties).toEqual([]);
    expect(labels.additional).toEqual({ kind: "string", constraints: {} });
  });

  // Regression: GitHub's reaction rollup has "+1" and "-1", which both became "1" and stopped generation.
  test("names without a camelCase form keep their wire spelling instead of colliding", async () => {
    const document = {
      openapi: "3.1.2",
      info: { title: "reactions", version: "1" },
      paths: {},
      components: { schemas: { Reactions: { type: "object", properties: { "+1": { type: "integer" }, "-1": { type: "integer" }, total_count: { type: "integer" } } } } },
    };
    const config = await loadConfig(undefined, { input: "inline", output: "out", naming: { properties: "camelCase" } });
    const intermediateFormat = planTransforms(normalize(document, "3.1", "inline"), config);
    const reactions = intermediateFormat.declarations[0]!.type;
    if (reactions.kind !== "object") {
      throw new Error(`expected an object, got ${reactions.kind}`);
    }
    expect(reactions.properties.map((property) => [property.name, property.appName])).toEqual([["+1", "+1"], ["-1", "-1"], ["total_count", "totalCount"]]);
  });

  test("preserve is the default", async () => {
    const intermediateFormat = await plannedIr("test/fixtures/features-3.1.json");
    expect(propertyOf(intermediateFormat, "SnakeCase", "first_name").appName).toBe("first_name");
  });

  test("two wire names mapping to one app name is an error naming both", async () => {
    await expect(plannedIr("test/fixtures/collision-3.1.yaml", { naming: { properties: "camelCase" } })).rejects.toThrow('properties "userId" and "user_id" of Clash both become "userId"');
  });
});

describe("T3 hooks", () => {
  const decimalHook = { type: "Decimal", import: "./decimal.ts", decode: "toDecimal", encode: "fromDecimal" };

  test("format hooks override T1, schema hooks override format hooks", async () => {
    const intermediateFormat = await plannedIr("test/fixtures/features-3.1.json", {
      transformers: {
        "format:int64": decimalHook,
        "format:date": { ...decimalHook, type: "PlainDate" },
        "schema:Labels": { ...decimalHook, type: "LabelMap" },
      },
    });
    expect(intermediateFormat.hooks["format:int64"]).toEqual(decimalHook);
    expect(propertyOf(intermediateFormat, "SnakeCase", "balance_cents").type.codec).toEqual({ kind: "hook", hook: "format:int64" });
    expect(propertyOf(intermediateFormat, "SnakeCase", "birth_date").type.codec).toEqual({ kind: "hook", hook: "format:date" });
    expect(declarationOf(intermediateFormat, "Labels").type.codec).toEqual({ kind: "hook", hook: "schema:Labels" });
  });

  test("schema hook for an unknown component is an error", async () => {
    await expect(plannedIr("test/fixtures/features-3.1.json", { transformers: { "schema:Nope": decimalHook } })).rejects.toThrow('transformer "schema:Nope": no schema named Nope');
  });
});

describe("transformed and runtime flags", () => {
  test("transformed propagates through references", async () => {
    const petstore = await plannedIr("test/fixtures/petstore-3.0.yaml");
    // Pet has created_at (date-time) and id (int64); NewPet has neither.
    expect(declarationOf(petstore, "Pet").transformed).toBe(true);
    expect(declarationOf(petstore, "NewPet").transformed).toBe(false);
    expect(declarationOf(petstore, "PetStatus").transformed).toBe(false);
    const features = await plannedIr("test/fixtures/features-3.1.json");
    // Transformed through meta.generated_at, which is a date-time.
    expect(declarationOf(features, "GetTreesResponse").transformed).toBe(true);
    // Recursive, and the fixpoint terminates.
    expect(declarationOf(features, "TreeNode").transformed).toBe(false);
  });

  test("runtime marks what requests and responses reach", async () => {
    const intermediateFormat = await plannedIr("test/fixtures/features-3.1.json");
    const runtimeNames = intermediateFormat.declarations.filter((declaration) => declaration.runtime).map((declaration) => declaration.name);
    expect(runtimeNames.sort()).toEqual(["Circle", "GetTreesResponse", "GetTreesResponseMeta", "PutUntaggedRequest", "Shape", "Square", "TreeNode"]);
  });
});

test("planTransforms does not mutate its input", async () => {
  const { document, version } = await load(join(repositoryRoot, "test/fixtures/features-3.1.json"));
  const intermediateFormat = normalize(document, version, "features");
  const before = JSON.stringify(intermediateFormat);
  planTransforms(intermediateFormat, await loadConfig(undefined, { input: "features", output: "out", naming: { properties: "camelCase" } }));
  expect(JSON.stringify(intermediateFormat)).toBe(before);
});
