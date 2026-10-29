import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { load } from "../src/intermediate-format/load.ts";
import { SpecValidationError, stripRefSiblings, validateSpec } from "../src/intermediate-format/validate-spec.ts";

const repositoryRoot = join(import.meta.dir, "..");
const loadFile = (path: string) => load(join(repositoryRoot, path));

describe("validateSpec", () => {
  for (const name of ["petstore-3.0.yaml", "petstore-3.1.yaml", "features-3.1.json", "features-3.2.yaml"]) {
    test(`${name} passes`, async () => {
      const { document, version } = await loadFile(`test/fixtures/${name}`);
      await validateSpec(document, version);
    });
  }

  test("invalid-3.1.yaml fails with the pointer of the bad value", async () => {
    const { document, version } = await loadFile("test/fixtures/invalid-3.1.yaml");
    const error = await validateSpec(document, version).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SpecValidationError);
    const badPointer = "/paths/~1broken/get/responses/200/content/application~1json/schema/type";
    expect((error as SpecValidationError).errors.map((diagnostic) => diagnostic.pointer)).toEqual([badPointer]);
    expect((error as SpecValidationError).message).toContain(badPointer);
  });

  // Every example spec must pass; the two with 3.0 `$ref` siblings only after stripping them.
  const examples = ["SpaceTraders.json", "petstore-api.yaml", "unified-api.yaml", "unified-api-next.yaml", "open-api-milkscout.json", "openapi-elastic.json", "open-api-jira.json"];
  for (const name of examples) {
    test(`examples/${name} passes after stripping $ref siblings`, async () => {
      const { document, version } = await loadFile(`examples/${name}`);
      const stripped = stripRefSiblings(document, version);
      await validateSpec(stripped.document, version);
    }, 30_000);
  }
});

describe("stripRefSiblings", () => {
  test("warns once per pointer for the two VERIFIED offenders", async () => {
    const petstore = await loadFile("examples/petstore-api.yaml");
    const petstoreResult = stripRefSiblings(petstore.document, petstore.version);
    expect(petstoreResult.warnings).toContainEqual({ pointer: "/components/schemas/Pet/properties/tags/items", message: 'ignored "xml" next to $ref (not allowed in OpenAPI 3.0)' });

    const jira = await loadFile("examples/open-api-jira.json");
    const jiraResult = stripRefSiblings(jira.document, jira.version);
    expect(jiraResult.warnings).toContainEqual({ pointer: "/components/schemas/Fields/properties/issuetype", message: 'ignored "description" next to $ref (not allowed in OpenAPI 3.0)' });
  });

  test("does not mutate its input", async () => {
    const { document, version } = await loadFile("examples/petstore-api.yaml");
    const before = JSON.stringify(document);
    stripRefSiblings(document, version);
    expect(JSON.stringify(document)).toBe(before);
  });

  test("leaves 3.1 documents alone, siblings are legal there", async () => {
    const { document, version } = await loadFile("test/fixtures/features-3.1.json");
    const result = stripRefSiblings(document, version);
    expect(result.warnings).toEqual([]);
    expect(result.document).toBe(document);
  });

  test("ignores $ref-looking data inside examples, defaults and extensions", () => {
    const document = {
      openapi: "3.0.4",
      components: {
        schemas: {
          WithData: { type: "object", example: { $ref: "x", note: "data" }, default: { $ref: "y", count: 1 }, "x-meta": { $ref: "z", kind: 2 } },
          PropertyNamedRef: { type: "object", properties: { $ref: { type: "string" } } },
        },
      },
    };
    expect(stripRefSiblings(document, "3.0").warnings).toEqual([]);
  });
});
