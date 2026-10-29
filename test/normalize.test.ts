import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "../src/intermediate-format/load.ts";
import { normalize } from "../src/intermediate-format/normalize.ts";
import type { IntermediateFormat, Operation, TypeNode } from "../src/intermediate-format/types.ts";

const repositoryRoot = join(import.meta.dir, "..");

async function intermediateFormatOf(path: string): Promise<IntermediateFormat> {
  const { document, version } = await load(join(repositoryRoot, path));
  return normalize(document, version, path);
}

function typeOf(intermediateFormat: IntermediateFormat, name: string): TypeNode {
  const declaration = intermediateFormat.declarations.find((candidate) => candidate.name === name);
  if (declaration === undefined) {
    throw new Error(`no declaration ${name}`);
  }
  return declaration.type;
}

function operationOf(intermediateFormat: IntermediateFormat, name: string): Operation {
  const operations = intermediateFormat.services.flatMap((service) => service.operations);
  return operations.find((operation) => operation.name === name)!;
}

/** Normalizes a one-schema document and returns that schema's type. */
function convertInline(openapiVersion: string, schema: unknown): TypeNode {
  const document = { openapi: openapiVersion, info: { title: "inline", version: "1" }, paths: {}, components: { schemas: { Subject: schema } } };
  const minorVersion = openapiVersion.slice(0, 3) as "3.0" | "3.1" | "3.2";
  return typeOf(normalize(document, minorVersion, "inline"), "Subject");
}

describe("normalizeSchema", () => {
  const plainString = { kind: "string", constraints: {} };
  test.each<[string, string, unknown, unknown]>([
    ["3.0 nullable", "3.0.4", { type: "string", nullable: true }, { kind: "union", mode: "anyOf", members: [plainString, { kind: "null" }] }],
    ["3.0 nullable is ignored in 3.1", "3.1.2", { type: "string", nullable: true }, plainString],
    ["3.1 type array", "3.1.2", { type: ["string", "null"] }, { kind: "union", mode: "anyOf", members: [plainString, { kind: "null" }] }],
    ["3.0 boolean exclusiveMinimum", "3.0.4", { type: "number", minimum: 3, exclusiveMinimum: true }, { kind: "number", integer: false, constraints: { exclusiveMinimum: 3 } }],
    ["3.0 exclusiveMinimum false", "3.0.4", { type: "number", minimum: 3, exclusiveMinimum: false }, { kind: "number", integer: false, constraints: { minimum: 3 } }],
    ["3.1 numeric exclusiveMinimum", "3.1.2", { type: "integer", exclusiveMinimum: 3 }, { kind: "number", integer: true, constraints: { exclusiveMinimum: 3 } }],
    ["const", "3.1.2", { const: "fixed" }, { kind: "literal", value: "fixed" }],
    ["enum with 3.0 nullable", "3.0.4", { type: "string", enum: ["first", "second"], nullable: true }, { kind: "enum", values: ["first", "second", null] }],
    ["binary", "3.1.2", { type: "string", format: "binary" }, { kind: "binary" }],
    ["boolean schema true", "3.1.2", true, { kind: "unknown" }],
    ["boolean schema false", "3.1.2", false, { kind: "never" }],
    ["empty schema", "3.1.2", {}, { kind: "unknown" }],
    ["implied object", "3.0.4", { properties: { flag: { type: "boolean" } } }, { kind: "object", properties: [{ name: "flag", appName: "flag", required: false, type: { kind: "boolean" } }], additional: true, constraints: {} }],
    ["tuple", "3.1.2", { type: "array", prefixItems: [{ type: "string" }], items: false }, { kind: "tuple", prefix: [plainString], rest: false, constraints: {} }],
    ["map", "3.1.2", { type: "object", additionalProperties: { type: "string" } }, { kind: "object", properties: [], additional: plainString, constraints: {} }],
  ])("%s", (_description, openapiVersion, schema, expected) => {
    expect(convertInline(openapiVersion, schema)).toEqual(expected as TypeNode);
  });

  test("properties are sorted, required is per property", () => {
    const type = convertInline("3.1.2", { type: "object", required: ["second"], properties: { second: { type: "string" }, first: { type: "string" } } });
    if (type.kind !== "object") {
      throw new Error(`expected an object, got ${type.kind}`);
    }
    expect(type.properties.map((property) => [property.name, property.required])).toEqual([["first", false], ["second", true]]);
  });

  test("unsupported keywords widen and warn, never narrow", async () => {
    const intermediateFormat = await intermediateFormatOf("test/fixtures/features-3.1.json");
    expect(typeOf(intermediateFormat, "Unsupported")).toEqual({ kind: "unknown" });
    expect(intermediateFormat.warnings.map((warning) => warning.message)).toContainEqual(expect.stringContaining('keyword "not" is not supported'));
  });

  test("recursive schemas terminate as name references", async () => {
    const type = typeOf(await intermediateFormatOf("test/fixtures/features-3.1.json"), "TreeNode");
    if (type.kind !== "object") {
      throw new Error(`expected an object, got ${type.kind}`);
    }
    const children = type.properties.find((property) => property.name === "children");
    expect(children?.type).toEqual({ kind: "array", items: { kind: "ref", name: "TreeNode" }, constraints: {} });
  });

  test("oneOf with discriminator gets an implicit mapping", async () => {
    expect(typeOf(await intermediateFormatOf("test/fixtures/features-3.1.json"), "Shape")).toEqual({
      kind: "union",
      mode: "oneOf",
      members: [{ kind: "ref", name: "Circle" }, { kind: "ref", name: "Square" }],
      discriminator: { property: "kind", mapping: { Circle: "Circle", Square: "Square" } },
    });
  });

  test("$defs references become their own declaration, $ref annotations stay a plain reference", async () => {
    const intermediateFormat = await intermediateFormatOf("test/fixtures/features-3.1.json");
    expect(typeOf(intermediateFormat, "WithDefsInner").kind).toBe("object");
    expect(typeOf(intermediateFormat, "Described")).toEqual({ kind: "ref", name: "Labels" });
  });

  // Regression: a schema that is itself an array of inline objects named its item after itself, which clashed and
  // produced `<Name>_1` (49 times in the GitHub REST spec, twice in OpenAI's through anyOf members).
  test("items of a root array, or of an array inside a root anyOf member, are named <Name>Item", () => {
    const document = {
      openapi: "3.1.2",
      info: { title: "root arrays", version: "1" },
      paths: {},
      components: {
        schemas: {
          RouteStats: { type: "array", items: { type: "object", properties: { count: { type: "integer" } } } },
          Modalities: { anyOf: [{ type: "array", items: { type: "string", enum: ["text", "audio"] } }, { type: "null" }] },
        },
      },
    };
    const intermediateFormat = normalize(document, "3.1", "inline");
    expect(intermediateFormat.warnings).toEqual([]);
    expect(typeOf(intermediateFormat, "RouteStats")).toEqual({ kind: "array", items: { kind: "ref", name: "RouteStatsItem" }, constraints: {} });
    expect(intermediateFormat.declarations.map((declaration) => declaration.name).sort()).toEqual(["Modalities", "ModalitiesItem", "RouteStats", "RouteStatsItem"]);
  });

  test("inline enums and objects are extracted as <Parent><Prop>, composition members stay inline", async () => {
    const intermediateFormat = await intermediateFormatOf("test/fixtures/features-3.1.json");
    expect(intermediateFormat.declarations.find((declaration) => declaration.name === "GetTreesResponseMeta")?.kind).toBe("response");
    const pet = typeOf(await intermediateFormatOf("test/fixtures/petstore-3.0.yaml"), "Pet");
    if (pet.kind !== "intersection") {
      throw new Error(`expected an intersection, got ${pet.kind}`);
    }
    expect(pet.members.map((member) => member.kind)).toEqual(["ref", "object"]);
  });
});

describe("normalizeOperations", () => {
  test("3.2: query method, additionalOperations, querystring, itemSchema streams", async () => {
    const intermediateFormat = await intermediateFormatOf("test/fixtures/features-3.2.yaml");
    expect(operationOf(intermediateFormat, "searchItems").method).toBe("QUERY");
    expect(operationOf(intermediateFormat, "purgeItem")).toMatchObject({ method: "PURGE", path: "/items/{id}", parameters: { path: { declaration: "PurgeItemPathParameter" } } });
    expect(operationOf(intermediateFormat, "listItems").querystring).toMatchObject({ name: "filter", contentType: "application/x-www-form-urlencoded", required: false });
    expect(operationOf(intermediateFormat, "streamItems").responses[0]).toMatchObject({ status: "200", contentType: "application/jsonl", stream: true, type: { kind: "ref", name: "Item" } });
  });

  test("first tag wins, untagged goes to DefaultService, derived ids for missing operationId", async () => {
    const intermediateFormat = await intermediateFormatOf("test/fixtures/features-3.1.json");
    const summary = intermediateFormat.services.map((service) => [service.name, service.folder, service.operations.map((operation) => operation.name)]);
    expect(summary).toEqual([
      ["ShapesService", "shapes", ["getShape"]],
      ["IssueCustomFieldValuesAppsService", "issue-custom-field-values-apps", ["getTrees"]],
      ["DefaultService", "default", ["putUntagged"]],
    ]);
  });

  test("path-level parameters merge, cookie and header groups", async () => {
    const intermediateFormat = await intermediateFormatOf("test/fixtures/petstore-3.0.yaml");
    expect(operationOf(intermediateFormat, "getPet").parameters.path?.parameters.map((parameter) => parameter.name)).toEqual(["petId"]);
    expect(operationOf(intermediateFormat, "listPets").parameters).toMatchObject({ query: { declaration: "ListPetsQueryParameter", required: false }, header: { declaration: "ListPetsHeaderParameter" } });
    const getShape = operationOf(await intermediateFormatOf("test/fixtures/features-3.1.json"), "getShape");
    expect(getShape.parameters.cookie?.parameters[0]).toMatchObject({ name: "session", style: "form", explode: true });
  });

  test("success statuses, default last, bodiless responses", async () => {
    const intermediateFormat = await intermediateFormatOf("test/fixtures/petstore-3.0.yaml");
    expect(operationOf(intermediateFormat, "listPets")).toMatchObject({ success: ["200"], responses: [{ status: "200" }, { status: "default", type: { kind: "ref", name: "Error" } }] });
    expect(operationOf(intermediateFormat, "deletePet").responses).toEqual([{ status: "204", contentType: "", stream: false, description: "Deleted" }]);
  });

  test("tags ending in Service are not doubled", async () => {
    const intermediateFormat = await intermediateFormatOf("examples/unified-api.yaml");
    expect(intermediateFormat.services.map((service) => service.name)).toContain("HealthCheckService");
  });
});

describe("dist3 parity (names)", () => {
  test("SpaceTraders declarations match dist3 interface files exactly", async () => {
    const intermediateFormat = await intermediateFormatOf("examples/SpaceTraders.json");
    const goldenDirectory = join(import.meta.dir, "golden", "dist3", "interface");
    const expected = ["components", "request", "response", "parameter"].flatMap((kind) => {
      return readdirSync(join(goldenDirectory, kind)).map((fileName) => `${kind}/${fileName.replace(/\.ts$/, "")}`);
    });
    const actual = intermediateFormat.declarations.map((declaration) => `${declaration.kind}/${declaration.name}`);
    expect(actual.sort()).toEqual(expected.sort());
  });

  test("SpaceTraders method names match dist3 services", async () => {
    const intermediateFormat = await intermediateFormatOf("examples/SpaceTraders.json");
    const goldenDirectory = join(import.meta.dir, "golden", "dist3", "service");
    const serviceFiles = readdirSync(goldenDirectory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
    const expectedNames = serviceFiles.flatMap((entry) => {
      const text = readFileSync(join(entry.parentPath, entry.name), "utf8");
      return [...text.matchAll(/^ {4}(\w+) = async/gm)].map((match) => match[1]!);
    });
    const actualNames = intermediateFormat.services.flatMap((service) => service.operations.map((operation) => operation.name));
    expect(actualNames.sort()).toEqual(expectedNames.sort());
  });
});
