import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate as validate30 } from "@hyperjump/json-schema/openapi-3-0";
import { validate as validate31 } from "@hyperjump/json-schema/openapi-3-1";
import { validate as validate32 } from "@hyperjump/json-schema/openapi-3-2";

// Fixtures must be real OpenAPI documents, otherwise tests built on them prove nothing.
const fixtureDirectory = join(import.meta.dir, "fixtures");

function readFixture(name: string): any {
  const text = readFileSync(join(fixtureDirectory, name), "utf8");
  if (name.endsWith(".json")) {
    return JSON.parse(text);
  }
  return Bun.YAML.parse(text);
}

async function isSchemaValid(document: any): Promise<boolean> {
  const version = String(document.openapi);
  if (version.startsWith("3.0.")) {
    return (await validate30("https://spec.openapis.org/oas/3.0/schema", document)).valid;
  }
  if (version.startsWith("3.1.")) {
    return (await validate31("https://spec.openapis.org/oas/3.1/schema-base", document)).valid;
  }
  if (version.startsWith("3.2.")) {
    return (await validate32("https://spec.openapis.org/oas/3.2/schema-base", document)).valid;
  }
  throw new Error(`fixture has no 3.x version: ${version}`);
}

describe("fixtures", () => {
  const validFixtures = ["petstore-3.0.yaml", "petstore-3.1.yaml", "features-3.1.json", "features-3.2.yaml", "collision-3.1.yaml"];
  for (const name of validFixtures) {
    test(`${name} is a valid OpenAPI document`, async () => {
      expect(await isSchemaValid(readFixture(name))).toBe(true);
    });
  }

  test("invalid-3.1.yaml is rejected", async () => {
    expect(await isSchemaValid(readFixture("invalid-3.1.yaml"))).toBe(false);
  });
});
