// Reads JSON or YAML and detects the 3.x minor version; every later step branches on that version, not on keywords.
// VERIFIED: test/load.test.ts covers JSON, YAML and version detection.
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

export type OpenApiVersion = "3.0" | "3.1" | "3.2";

export type LoadedDocument = { document: Record<string, unknown>; version: OpenApiVersion };

/** Reads a JSON or YAML file whose top level must be an object (OpenAPI documents, overlays). */
export async function readStructuredFile(path: string): Promise<Record<string, unknown>> {
  const text = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    // YAML is a superset of JSON, but JSON.parse gives better errors for .json files.
    if (path.endsWith(".json")) {
      parsed = JSON.parse(text);
    } else {
      parsed = parseYaml(text);
    }
  } catch (error) {
    throw new Error(`cannot parse ${path}: ${(error as Error).message}`);
  }
  const isObject = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  if (!isObject) {
    throw new Error(`${path} must contain an object at the top level`);
  }
  return parsed as Record<string, unknown>;
}

/** Reads an OpenAPI document (JSON or YAML) and detects its 3.x minor version. */
export async function load(path: string): Promise<LoadedDocument> {
  const document = await readStructuredFile(path);
  if ("swagger" in document) {
    throw new Error(`${path}: OpenAPI 2.0 (Swagger) is not supported, convert it to 3.x first`);
  }
  const minorVersion = /^3\.([012])\.\d+/.exec(String(document.openapi))?.[1];
  if (minorVersion === undefined) {
    throw new Error(`${path}: unsupported OpenAPI version "${String(document.openapi)}" (supported: 3.0.x, 3.1.x, 3.2.x)`);
  }
  return { document, version: `3.${minorVersion}` as OpenApiVersion };
}
