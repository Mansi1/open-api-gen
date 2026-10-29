// OpenAPI Overlay 1.0 to 1.2. Targets use RFC 9535 JSONPath (jsonpath-rfc9535), which the Overlay spec names,
// rather than a JSONPath dialect whose filter semantics differ.
// VERIFIED: test/spec-transforms.test.ts and test/review-regressions.test.ts cover update, merge and remove.
import { exec } from "jsonpath-rfc9535";
import type { JsonValue } from "jsonpath-rfc9535";
import { unescapePointerToken } from "./refs.ts";
import type { Diagnostic } from "./types.ts";

// OpenAPI Overlay Specification 1.0, 1.1 and 1.2 (spec/overlay-1.2.0.md): an ordered list of actions, each
// selecting nodes with an RFC 9535 JSONPath `target` and then updating, copying into or removing them.

type JsonObject = Record<string, unknown>;
type PathSegment = string | number;
type Match = { value: unknown; path: PathSegment[] };
type Action = { target: string; update?: unknown; copy?: string; remove?: boolean; description?: string };

/** Applies every action of `overlay` in order to a copy of `document`. `overlayName` names the overlay in messages. */
export function applyOverlay(document: JsonObject, overlay: JsonObject, overlayName: string): { document: JsonObject; warnings: Diagnostic[] } {
  if (typeof overlay.overlay !== "string" || !/^1\.[0-2]\.\d+/.test(overlay.overlay)) {
    throw new Error(`${overlayName}: unsupported overlay version "${String(overlay.overlay)}" (supported: 1.0.x, 1.1.x, 1.2.x)`);
  }
  if (!Array.isArray(overlay.actions) || overlay.actions.length === 0) {
    throw new Error(`${overlayName}: "actions" must be a non-empty array`);
  }
  const result = structuredClone(document);
  const warnings: Diagnostic[] = [];
  overlay.actions.forEach((rawAction, index) => {
    const pointer = `/actions/${index}`;
    const action = resolveAction(overlay, rawAction, `${overlayName}${pointer}`);
    const matches = select(result, action.target, `${overlayName}${pointer}`);
    if (matches.length === 0) {
      // The spec says such an action succeeds without changes; a warning still helps catch typos in targets.
      warnings.push({ pointer, message: `${overlayName}: target ${JSON.stringify(action.target)} selects nothing` });
      return;
    }
    applyAction(result, action, matches, `${overlayName}${pointer}`);
  });
  return { document: result, warnings };
}

/** Turns an Action Object or a Reusable Action Reference Object (1.2) into a plain action. */
function resolveAction(overlay: JsonObject, rawAction: unknown, location: string): Action {
  if (typeof rawAction !== "object" || rawAction === null) {
    throw new Error(`${location}: an action must be an object`);
  }
  let fields = rawAction as JsonObject;
  if (typeof fields.$ref === "string") {
    const prefix = "#/components/actions/";
    if (!fields.$ref.startsWith(prefix)) {
      throw new Error(`${location}: $ref must point into ${prefix}`);
    }
    const key = unescapePointerToken(fields.$ref.slice(prefix.length));
    const reusable = ((overlay.components as JsonObject | undefined)?.actions as JsonObject | undefined)?.[key] as JsonObject | undefined;
    if (reusable === undefined) {
      throw new Error(`${location}: no reusable action "${key}" in components.actions`);
    }
    const { $ref: _ignoredReference, ...overrides } = fields;
    // Fields on the reference override the reusable action's fields (including its description).
    fields = { ...((reusable.fields ?? {}) as JsonObject), ...overrides };
  }
  if (typeof fields.target !== "string") {
    throw new Error(`${location}: "target" must be a JSONPath string`);
  }
  if (fields.remove !== undefined && typeof fields.remove !== "boolean") {
    throw new Error(`${location}: "remove" must be a boolean`);
  }
  if (fields.copy !== undefined && typeof fields.copy !== "string") {
    throw new Error(`${location}: "copy" must be a JSONPath string`);
  }
  if (fields.update !== undefined && fields.copy !== undefined && fields.remove !== true) {
    throw new Error(`${location}: an action cannot have both "update" and "copy"`);
  }
  return fields as Action;
}

function select(document: JsonObject, expression: string, location: string): Match[] {
  const matches: Match[] = [];
  try {
    exec(document as JsonValue, expression, (value, path) => {
      matches.push({ value, path: [...path] });
    });
  } catch (error) {
    throw new Error(`${location}: invalid JSONPath ${JSON.stringify(expression)}: ${(error as Error).message}`);
  }
  return matches;
}

function applyAction(document: JsonObject, action: Action, matches: Match[], location: string): void {
  if (action.remove === true) {
    removeMatches(document, matches, location);
    return;
  }
  let value: unknown;
  if (action.copy !== undefined) {
    const sources = select(document, action.copy, location);
    if (sources.length !== 1) {
      throw new Error(`${location}: copy ${JSON.stringify(action.copy)} must select exactly one node, selected ${sources.length}`);
    }
    value = sources[0]!.value;
  } else if ("update" in action) {
    value = action.update;
  } else {
    // An action without update, copy or remove changes nothing.
    return;
  }

  const kinds = new Set(matches.map((match) => kindOf(match.value)));
  if (kinds.size > 1) {
    throw new Error(`${location}: target selects a mix of ${[...kinds].join(" and ")} nodes; update and copy need nodes of one kind`);
  }
  for (const match of matches) {
    const target = match.value;
    if (Array.isArray(target)) {
      if (Array.isArray(value)) {
        target.push(...structuredClone(value));
      } else {
        target.push(structuredClone(value));
      }
    } else if (isPlainObject(target)) {
      if (!isPlainObject(value)) {
        throw new Error(`${location}: updating an object needs an object value`);
      }
      merge(target, value, location);
    } else {
      if (isPlainObject(value) || Array.isArray(value)) {
        throw new Error(`${location}: replacing a primitive needs a primitive value`);
      }
      replaceAt(document, match.path, value, location);
    }
  }
}

/** The recursive merge of the Action Object: primitives replace, arrays concatenate, objects merge. */
function merge(target: JsonObject, source: JsonObject, location: string): void {
  for (const [key, sourceValue] of Object.entries(source)) {
    if (!Object.hasOwn(target, key)) {
      target[key] = structuredClone(sourceValue);
      continue;
    }
    const targetValue = target[key];
    if (Array.isArray(targetValue) && Array.isArray(sourceValue)) {
      targetValue.push(...structuredClone(sourceValue));
    } else if (isPlainObject(targetValue) && isPlainObject(sourceValue)) {
      merge(targetValue, sourceValue, location);
    } else if (kindOf(targetValue) === "primitive" && kindOf(sourceValue) === "primitive") {
      target[key] = sourceValue;
    } else {
      throw new Error(`${location}: cannot merge ${kindOf(sourceValue)} into ${kindOf(targetValue)} at "${key}"`);
    }
  }
}

function removeMatches(document: JsonObject, matches: Match[], location: string): void {
  // Resolve every match to its parent container before changing anything, so a removal never shifts another match's path.
  const keysByParent = new Map<unknown, PathSegment[]>();
  for (const match of matches) {
    if (match.path.length === 0) {
      throw new Error(`${location}: cannot remove the document root`);
    }
    const parent = valueAt(document, match.path.slice(0, -1));
    const keys = keysByParent.get(parent) ?? [];
    keys.push(match.path[match.path.length - 1]!);
    keysByParent.set(parent, keys);
  }
  for (const [parent, keys] of keysByParent) {
    if (Array.isArray(parent)) {
      // Remove array elements from the highest index down, so the lower indexes stay valid.
      const indexes = [...new Set(keys.filter((key): key is number => typeof key === "number"))].sort((first, second) => second - first);
      for (const index of indexes) {
        parent.splice(index, 1);
      }
    } else if (isPlainObject(parent)) {
      for (const key of keys) {
        delete parent[String(key)];
      }
    }
  }
}

function replaceAt(document: JsonObject, path: PathSegment[], value: unknown, location: string): void {
  if (path.length === 0) {
    throw new Error(`${location}: cannot replace the document root`);
  }
  const parent = valueAt(document, path.slice(0, -1)) as Record<string | number, unknown>;
  parent[path[path.length - 1]!] = value;
}

function valueAt(document: JsonObject, path: PathSegment[]): unknown {
  let current: unknown = document;
  for (const segment of path) {
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kindOf(value: unknown): "object" | "array" | "primitive" {
  if (Array.isArray(value)) {
    return "array";
  }
  if (isPlainObject(value)) {
    return "object";
  }
  return "primitive";
}
