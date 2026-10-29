import type { OutputUnit } from "@hyperjump/json-schema";
import { validate as validate30 } from "@hyperjump/json-schema/openapi-3-0";
import { validate as validate31 } from "@hyperjump/json-schema/openapi-3-1";
import { validate as validate32 } from "@hyperjump/json-schema/openapi-3-2";
import type { OpenApiVersion } from "./load.ts";
import { escapePointerToken } from "./refs.ts";
import type { Diagnostic } from "./types.ts";

export class SpecValidationError extends Error {
  constructor(readonly errors: Diagnostic[]) {
    const plural = errors.length === 1 ? "" : "s";
    const lines = errors.map((error) => `  ${error.pointer}: ${error.message}`);
    super(`invalid OpenAPI document (${errors.length} error${plural}):\n${lines.join("\n")}`);
    this.name = "SpecValidationError";
  }
}

// schema-base also validates every Schema Object against the OpenAPI JSON Schema dialect; 3.0 has no schema-base.
const VALIDATORS = {
  "3.0": (document: any) => validate30("https://spec.openapis.org/oas/3.0/schema", document, "BASIC"),
  "3.1": (document: any) => validate31("https://spec.openapis.org/oas/3.1/schema-base", document, "BASIC"),
  "3.2": (document: any) => validate32("https://spec.openapis.org/oas/3.2/schema-base", document, "BASIC"),
};

/** Validates against the official OpenAPI schema for `version`; throws SpecValidationError listing every failing location. */
export async function validateSpec(document: unknown, version: OpenApiVersion): Promise<void> {
  const output = await VALIDATORS[version](document);
  if (output.valid) {
    return;
  }
  throw new SpecValidationError(toDiagnostics(output.errors ?? []));
}

/**
 * BASIC output lists every failing keyword, including all parents of the real failure (anyOf, $ref, ...).
 * Report only the deepest instance locations, and merge the keywords that failed at each of them.
 */
function toDiagnostics(units: OutputUnit[]): Diagnostic[] {
  const keywordsByPointer = new Map<string, Set<string>>();
  for (const unit of units) {
    const pointer = decodeURIComponent(unit.instanceLocation.replace(/^#/, ""));
    const keyword = unit.keyword.split("/").pop() ?? unit.keyword;
    let keywords = keywordsByPointer.get(pointer);
    if (keywords === undefined) {
      keywords = new Set();
      keywordsByPointer.set(pointer, keywords);
    }
    keywords.add(keyword);
  }

  const pointers = [...keywordsByPointer.keys()];
  const isParentOfAnother = (pointer: string) => pointers.some((other) => other !== pointer && other.startsWith(`${pointer}/`));
  const deepest = pointers.filter((pointer) => !isParentOfAnother(pointer)).sort();
  return deepest.map((pointer) => {
    const keywords = [...keywordsByPointer.get(pointer)!].sort();
    return { pointer, message: `fails ${keywords.join(", ")}` };
  });
}

// Values under these keys are user data, not OpenAPI objects, even when they look like a reference.
const DATA_KEYS = new Set(["example", "examples", "default", "enum", "const", "value"]);

/**
 * OpenAPI 3.0 says properties next to `$ref` SHALL be ignored, and its schema rejects them.
 * Real specs contain them often, so drop them with one warning per location instead of failing.
 * Returns the input unchanged for 3.1+, where siblings are legal.
 */
export function stripRefSiblings(document: Record<string, unknown>, version: OpenApiVersion): { document: Record<string, unknown>; warnings: Diagnostic[] } {
  if (version !== "3.0") {
    return { document, warnings: [] };
  }
  const warnings: Diagnostic[] = [];

  // `parentKey` is the key this value sits under; `ancestorKeys` are the keys above that one, outermost first.
  // A Path Item allows fields next to `$ref`: `paths/<path>` and, in a callback, `callbacks/<name>/<expression>`.
  const walk = (value: unknown, pointer: string, parentKey: string | undefined, ancestorKeys: string[] = []): unknown => {
    if (Array.isArray(value)) {
      return value.map((item, index) => walk(item, `${pointer}/${index}`, undefined));
    }
    if (typeof value !== "object" || value === null) {
      return value;
    }
    const object = value as Record<string, unknown>;

    // `properties` maps names to schemas, so a property literally called "$ref" is not a reference.
    const isPathItem = ancestorKeys.at(-1) === "paths" || ancestorKeys.at(-2) === "callbacks";
    const isReference = typeof object.$ref === "string" && parentKey !== "properties" && !isPathItem;
    if (isReference) {
      const siblings = Object.keys(object).filter((key) => key !== "$ref");
      for (const sibling of siblings) {
        warnings.push({ pointer, message: `ignored "${sibling}" next to $ref (not allowed in OpenAPI 3.0)` });
      }
      if (siblings.length === 0) {
        return object;
      }
      return { $ref: object.$ref };
    }

    const copy: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(object)) {
      const isData = DATA_KEYS.has(key) && parentKey !== "properties";
      const isExtension = key.startsWith("x-");
      if (isData || isExtension) {
        copy[key] = child;
      } else {
        copy[key] = walk(child, `${pointer}/${escapePointerToken(key)}`, key, parentKey === undefined ? ancestorKeys : [...ancestorKeys, parentKey]);
      }
    }
    return copy;
  };

  const stripped = walk(document, "", undefined) as Record<string, unknown>;
  if (warnings.length === 0) {
    return { document, warnings };
  }
  return { document: stripped, warnings };
}
