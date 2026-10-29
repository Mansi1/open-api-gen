// Operation filters plus pruning of components nothing references any more, so a filtered client contains only
// the types its remaining operations reach.
// VERIFIED: test/spec-transforms.test.ts checks pruning; test/review-regressions.test.ts referenced Path Items.
import type { Config } from "./config.ts";
import type { OpenApiVersion } from "./load.ts";
import { escapePointerToken, mergePathItem, refPointer, unescapePointerToken } from "./refs.ts";
import type { Diagnostic } from "./types.ts";

type JsonObject = Record<string, unknown>;

const STANDARD_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const COMPONENT_SECTIONS = ["schemas", "responses", "parameters", "requestBodies", "headers", "examples", "links", "callbacks", "pathItems", "mediaTypes"];

/**
 * Keeps the operations the filter selects, drops path items left without operations, and then removes every
 * component that nothing kept still references, so the generated client contains only what is used.
 * An empty filter returns the document unchanged.
 */
export function filterSpec(document: JsonObject, version: OpenApiVersion, filter: Config["filter"]): { document: JsonObject; warnings: Diagnostic[] } {
  const hasFilter = filter.tags !== undefined || filter.excludeTags !== undefined || filter.operationIds !== undefined;
  if (!hasFilter) {
    return { document, warnings: [] };
  }
  const result = structuredClone(document);
  const warnings: Diagnostic[] = [];
  const seenTags = new Set<string>();
  const seenOperationIds = new Set<string>();
  let keptOperations = 0;

  const paths = (result.paths ?? {}) as JsonObject;
  for (const [path, pathItemValue] of Object.entries(paths)) {
    // A referenced Path Item is inlined first, so its operations are filtered like any other.
    const pathItem = mergePathItem(result, pathItemValue as JsonObject) as JsonObject;
    paths[path] = pathItem;
    for (const { container, key } of operationSlots(pathItem, version)) {
      const operation = container[key] as JsonObject;
      const tags = Array.isArray(operation.tags) ? operation.tags.map(String) : [];
      tags.forEach((tag) => seenTags.add(tag));
      if (typeof operation.operationId === "string") {
        seenOperationIds.add(operation.operationId);
      }
      if (isSelected(operation, tags, filter)) {
        keptOperations++;
      } else {
        delete container[key];
      }
    }
    const additional = pathItem.additionalOperations;
    if (typeof additional === "object" && additional !== null && Object.keys(additional).length === 0) {
      delete pathItem.additionalOperations;
    }
    if (operationSlots(pathItem, version).length === 0) {
      delete paths[path];
    }
  }

  for (const tag of [...(filter.tags ?? []), ...(filter.excludeTags ?? [])]) {
    if (!seenTags.has(tag)) {
      warnings.push({ pointer: "/tags", message: `filter: no operation has the tag ${JSON.stringify(tag)}` });
    }
  }
  for (const operationId of filter.operationIds ?? []) {
    if (!seenOperationIds.has(operationId)) {
      warnings.push({ pointer: "/paths", message: `filter: no operation has the operationId ${JSON.stringify(operationId)}` });
    }
  }
  if (keptOperations === 0) {
    warnings.push({ pointer: "/paths", message: "filter: no operation is left; the client will have no services" });
  }

  pruneComponents(result);
  return { document: result, warnings };
}

function isSelected(operation: JsonObject, tags: string[], filter: Config["filter"]): boolean {
  if (filter.tags !== undefined && !tags.some((tag) => filter.tags!.includes(tag))) {
    return false;
  }
  if (filter.operationIds !== undefined && !filter.operationIds.includes(String(operation.operationId))) {
    return false;
  }
  if (filter.excludeTags !== undefined && tags.some((tag) => filter.excludeTags!.includes(tag))) {
    return false;
  }
  return true;
}

/** Where the operations of a path item live: method keys, and in 3.2 also `query` and `additionalOperations`. */
function operationSlots(pathItem: JsonObject, version: OpenApiVersion): { container: JsonObject; key: string }[] {
  const methods = version === "3.2" ? [...STANDARD_METHODS, "query"] : STANDARD_METHODS;
  const slots = methods.filter((method) => pathItem[method] !== undefined).map((method) => ({ container: pathItem, key: method }));
  const additional = pathItem.additionalOperations;
  if (version === "3.2" && typeof additional === "object" && additional !== null) {
    for (const method of Object.keys(additional)) {
      slots.push({ container: additional as JsonObject, key: method });
    }
  }
  return slots;
}

/** Removes components no kept part of the document references, directly or through other components. */
function pruneComponents(document: JsonObject): void {
  const components = document.components as JsonObject | undefined;
  if (components === undefined) {
    return;
  }
  const reachable = new Set<string>();
  const pending: unknown[] = [];
  // Everything outside components is a root: paths, webhooks, and top-level security requirements.
  for (const [key, value] of Object.entries(document)) {
    if (key !== "components") {
      pending.push(value);
    }
  }
  while (pending.length > 0) {
    for (const pointer of referencesIn(pending.pop())) {
      if (reachable.has(pointer)) {
        continue;
      }
      reachable.add(pointer);
      pending.push(valueAtPointer(document, pointer));
    }
  }
  for (const section of COMPONENT_SECTIONS) {
    const entries = components[section] as JsonObject | undefined;
    if (entries === undefined) {
      continue;
    }
    for (const name of Object.keys(entries)) {
      const pointer = `/components/${section}/${escapePointerToken(name)}`;
      const isUsed = [...reachable].some((reference) => reference === pointer || reference.startsWith(`${pointer}/`));
      if (!isUsed) {
        delete entries[name];
      }
    }
  }
}

/** Every local `$ref` below `value`, plus discriminator mappings, which name schemas without a `$ref`. */
function referencesIn(value: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== "object" || node === null) {
      return;
    }
    const object = node as JsonObject;
    if (typeof object.$ref === "string" && object.$ref.startsWith("#/")) {
      found.push(refPointer(object.$ref));
    }
    const discriminator = object.discriminator as JsonObject | undefined;
    if (typeof discriminator?.mapping === "object" && discriminator.mapping !== null) {
      for (const target of Object.values(discriminator.mapping as Record<string, string>)) {
        found.push(target.startsWith("#") ? refPointer(target) : `/components/schemas/${escapePointerToken(target)}`);
      }
    }
    for (const [key, child] of Object.entries(object)) {
      // Example values are data, even when they contain something that looks like a $ref. `examples` is data
      // in a schema (an array), but a map of Example Objects, which may be references, on media types.
      const isData = key === "example" || key === "default" || key === "enum" || key === "const" || (key === "examples" && Array.isArray(child));
      if (!isData) {
        walk(child);
      }
    }
  };
  walk(value);
  return found;
}

function valueAtPointer(document: JsonObject, pointer: string): unknown {
  let current: unknown = document;
  for (const token of pointer.split("/").slice(1).map(unescapePointerToken)) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = (current as JsonObject)[token];
  }
  return current;
}
