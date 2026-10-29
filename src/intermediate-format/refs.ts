// Local `$ref` resolution only. Remote references are rejected (UnsupportedRefError) instead of fetched, so the
// generator never reads the network or files outside the inputs it was given.
// VERIFIED: test/refs.test.ts checks that non-local refs raise UnsupportedRefError.
export class UnsupportedRefError extends Error {
  constructor(readonly ref: string) {
    super(`unsupported $ref "${ref}": only local references (#/...) are supported`);
    this.name = "UnsupportedRefError";
  }
}

/** Looks up a local `$ref` (`#/a/b`) as a JSON Pointer with URI-fragment encoding. */
export function resolve(document: unknown, ref: string): unknown {
  if (!ref.startsWith("#")) {
    throw new UnsupportedRefError(ref);
  }
  let current = document;
  for (const token of pointerTokens(ref)) {
    const isContainer = typeof current === "object" && current !== null;
    if (!isContainer || !Object.hasOwn(current as object, token)) {
      throw new Error(`cannot resolve $ref "${ref}"`);
    }
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

/**
 * Follows `$ref` chains until a value that is not a reference.
 * `pointer` is where that final value lives; it is undefined WHEN `value` was no reference to begin with.
 */
export function deref(document: unknown, value: unknown): { value: unknown; pointer: string | undefined } {
  const visited = new Set<string>();
  let current = value;
  let pointer: string | undefined;
  while (isRef(current)) {
    if (visited.has(current.$ref)) {
      throw new Error(`$ref loop: ${[...visited, current.$ref].join(" → ")}`);
    }
    visited.add(current.$ref);
    pointer = refPointer(current.$ref);
    current = resolve(document, current.$ref);
  }
  return { value: current, pointer };
}

export function isRef(value: unknown): value is { $ref: string } {
  return typeof value === "object" && value !== null && typeof (value as { $ref?: unknown }).$ref === "string";
}

function pointerTokens(ref: string): string[] {
  if (ref === "#" || ref === "#/") {
    return [];
  }
  return refPointer(ref).slice(1).split("/").map(unescapePointerToken);
}

/** The JSON Pointer of a local `$ref` (`#/a%20b` → `/a b`); a malformed percent-encoding names the ref. */
export function refPointer(ref: string): string {
  try {
    return decodeURIComponent(ref.slice(1));
  } catch {
    throw new Error(`cannot resolve $ref "${ref}": malformed percent-encoding`);
  }
}

/** A Path Item with a `$ref` merged with its own fields; the local fields win. */
export function mergePathItem(document: unknown, pathItem: Record<string, unknown>): Record<string, unknown> {
  if (!isRef(pathItem)) {
    return pathItem;
  }
  const { $ref: _ref, ...local } = pathItem;
  return { ...(deref(document, pathItem).value as Record<string, unknown>), ...local };
}

/** Escapes one JSON Pointer token (`~` → `~0`, `/` → `~1`). */
export function escapePointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function unescapePointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}
