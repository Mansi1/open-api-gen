// Bundles a multi-file OpenAPI document into one, so every later step (overlays, validation, normalize, the written
// open-api.json) works on a single self-contained document with local references only.
// - A reference in a schema, parameter, response, request body, header, example, link or callback position hoists
//   its target into `components/<section>` under a name from the file or pointer (`./schemas/pet.yaml` → `pet`),
//   once per target, so shared schemas stay one declaration instead of one inline copy per use.
// - A reference that IS a definition (`components/schemas/Pet: {$ref: ./pet.yaml}`, a path item) is inlined there.
// - Inside an external file, `#/…` means that file. Example and default values are data and are left alone.
// - Files may come only from the reference root (default: the root document's directory), because the document is
//   untrusted input and its referenced files end up in the written open-api.json. URLs are rejected: no network.
// VERIFIED: test/bundle.test.ts generates from a multi-file fixture and checks hoisting, cycles and the root check.
import { realpathSync } from "node:fs";
import { dirname, extname, basename, isAbsolute, relative, resolve as resolvePath } from "node:path";
import { readStructuredFile } from "./load.ts";
import { escapePointerToken, unescapePointerToken, UnsupportedRefError } from "./refs.ts";

type JsonObject = Record<string, unknown>;

/** How a node is read: as a Schema Object, as other OpenAPI structure, or as plain data (examples, defaults). */
type Kind = "schema" | "other" | "data";

/** Where a `$ref` found at a node goes: hoisted into a components section, or inlined at a definition position. */
type RefPlacement = { hoist: string } | { define: string } | undefined;

const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const SCHEMA_KEYWORDS = new Set(["items", "additionalProperties", "not", "if", "then", "else", "contains", "propertyNames", "unevaluatedItems", "unevaluatedProperties", "additionalItems", "contentSchema"]);
const SCHEMA_LIST_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_DATA_KEYWORDS = new Set(["example", "examples", "default", "enum", "const"]);
/** Map-valued fields of other OpenAPI objects whose entries hoist into the components section of the same name. */
const COMPONENT_MAPS = new Set(["responses", "headers", "examples", "links", "callbacks"]);
const COMPONENT_SECTIONS = new Set(["schemas", "parameters", "responses", "requestBodies", "headers", "examples", "links", "callbacks", "securitySchemes", "pathItems", "mediaTypes"]);
/** Component keys must match `^[a-zA-Z0-9.\-_]+$` (OpenAPI Components Object). */
const COMPONENT_KEY_INVALID = /[^a-zA-Z0-9.\-_]/g;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRemote(reference: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(reference);
}

class Bundler {
  private readonly files = new Map<string, Promise<JsonObject>>();
  /** `<absolute file>#<pointer>` → the local `$ref` its hoisted or defined copy has. */
  private readonly placedTargets = new Map<string, string>();
  private readonly hoisted = new Map<string, Map<string, unknown>>();
  private readonly usedNames = new Map<string, Set<string>>();
  /** Targets being inlined right now; seeing one again is a reference cycle that inlining cannot express. */
  private readonly inlining = new Set<string>();

  constructor(
    private readonly rootDocument: JsonObject,
    private readonly rootPath: string,
    private readonly refRoot: string,
  ) {
    const components = isObject(rootDocument.components) ? rootDocument.components : {};
    for (const [section, entries] of Object.entries(components)) {
      this.usedNames.set(section, new Set(isObject(entries) ? Object.keys(entries) : []));
    }
  }

  async run(): Promise<JsonObject> {
    const bundled = (await this.walk(this.rootDocument, this.rootPath, "other", undefined, "")) as JsonObject;
    if (this.hoisted.size === 0) {
      return bundled;
    }
    const components: JsonObject = isObject(bundled.components) ? { ...bundled.components } : {};
    for (const [section, entries] of this.hoisted) {
      components[section] = { ...(isObject(components[section]) ? components[section] : {}), ...Object.fromEntries(entries) };
    }
    return { ...bundled, components };
  }

  private load(file: string): Promise<JsonObject> {
    let loaded = this.files.get(file);
    if (loaded === undefined) {
      loaded = readStructuredFile(file);
      this.files.set(file, loaded);
    }
    return loaded;
  }

  /** `path` is the node's JSON Pointer inside the root document, or undefined inside external content. */
  private async walk(node: unknown, baseFile: string, kind: Kind, placement: RefPlacement, path: string | undefined): Promise<unknown> {
    if (kind === "data") {
      return node;
    }
    if (Array.isArray(node)) {
      // One after the other: names are reserved in walking order, so colliding names get the same suffix every run.
      const items: unknown[] = [];
      for (const item of node) {
        items.push(await this.walk(item, baseFile, kind, placement, undefined));
      }
      return items;
    }
    if (!isObject(node)) {
      return node;
    }
    if (typeof node.$ref === "string") {
      return this.walkReference(node, baseFile, kind, placement);
    }
    const result: JsonObject = {};
    for (const [key, value] of Object.entries(node)) {
      const childPath = path === undefined ? undefined : `${path}/${escapePointerToken(key)}`;
      result[key] = await this.walkChild(key, value, baseFile, kind, childPath, path);
    }
    return result;
  }

  private async walkChild(key: string, value: unknown, baseFile: string, kind: Kind, childPath: string | undefined, parentPath: string | undefined): Promise<unknown> {
    if (key.startsWith("x-")) {
      return value;
    }
    if (kind === "schema") {
      if (SCHEMA_MAP_KEYWORDS.has(key) && isObject(value)) {
        return this.walkMap(value, baseFile, "schema", { hoist: "schemas" });
      }
      if (SCHEMA_LIST_KEYWORDS.has(key) || SCHEMA_KEYWORDS.has(key)) {
        return this.walk(value, baseFile, "schema", { hoist: "schemas" }, undefined);
      }
      if (key === "discriminator" && isObject(value)) {
        return this.walkDiscriminator(value, baseFile);
      }
      if (SCHEMA_DATA_KEYWORDS.has(key)) {
        return value;
      }
      return this.walk(value, baseFile, "other", undefined, undefined);
    }
    // Other OpenAPI structure.
    if (key === "schema" || key === "itemSchema") {
      return this.walk(value, baseFile, "schema", { hoist: "schemas" }, undefined);
    }
    if (key === "example" || key === "value" || key === "default") {
      return value;
    }
    if (parentPath === "" && key === "components" && isObject(value)) {
      const sections: JsonObject = {};
      for (const [section, entries] of Object.entries(value)) {
        sections[section] = COMPONENT_SECTIONS.has(section) && isObject(entries) ? await this.walkComponentSection(section, entries, baseFile) : entries;
      }
      return sections;
    }
    if (key === "parameters") {
      return this.walk(value, baseFile, "other", { hoist: "parameters" }, undefined);
    }
    if (key === "requestBody") {
      return this.walk(value, baseFile, "other", { hoist: "requestBodies" }, undefined);
    }
    if (COMPONENT_MAPS.has(key) && isObject(value)) {
      return this.walkMap(value, baseFile, "other", { hoist: key });
    }
    if (parentPath === "" && key === "paths" && isObject(value)) {
      // Path items are inlined where they are referenced: that position is their definition.
      return this.walkMap(value, baseFile, "other", undefined);
    }
    return this.walk(value, baseFile, "other", undefined, childPath);
  }

  private async walkMap(map: JsonObject, baseFile: string, kind: Kind, placement: RefPlacement): Promise<JsonObject> {
    const result: JsonObject = {};
    for (const [key, value] of Object.entries(map)) {
      result[key] = await this.walk(value, baseFile, kind, placement, undefined);
    }
    return result;
  }

  private async walkComponentSection(section: string, entries: JsonObject, baseFile: string): Promise<JsonObject> {
    const result: JsonObject = {};
    const kind: Kind = section === "schemas" ? "schema" : "other";
    for (const [name, value] of Object.entries(entries)) {
      result[name] = await this.walk(value, baseFile, kind, { define: `#/components/${section}/${escapePointerToken(name)}` }, undefined);
    }
    return result;
  }

  /** Mapping values that are URI references (not plain schema names) point at schemas like any `$ref`. */
  private async walkDiscriminator(discriminator: JsonObject, baseFile: string): Promise<JsonObject> {
    if (!isObject(discriminator.mapping)) {
      return discriminator;
    }
    const mapping: JsonObject = {};
    for (const [tag, target] of Object.entries(discriminator.mapping)) {
      const isReference = typeof target === "string" && (target.includes("#") || target.includes("/") || /\.(ya?ml|json)$/.test(target));
      if (!isReference) {
        mapping[tag] = target;
        continue;
      }
      const placed = (await this.walkReference({ $ref: target }, baseFile, "schema", { hoist: "schemas" })) as { $ref: string };
      mapping[tag] = placed.$ref;
    }
    return { ...discriminator, mapping };
  }

  private async walkReference(node: JsonObject, baseFile: string, kind: Kind, placement: RefPlacement): Promise<unknown> {
    const reference = node.$ref as string;
    // A local reference in the root document stays as it is.
    if (baseFile === this.rootPath && reference.startsWith("#")) {
      return node;
    }
    if (isRemote(reference)) {
      throw new UnsupportedRefError(reference);
    }
    const hashIndex = reference.indexOf("#");
    const filePart = hashIndex === -1 ? reference : reference.slice(0, hashIndex);
    const fragment = hashIndex === -1 ? "" : reference.slice(hashIndex + 1);
    const targetFile = filePart === "" ? baseFile : resolvePath(dirname(baseFile), decodeURI(filePart));
    this.checkInsideRoot(targetFile, reference);
    const siblings = Object.fromEntries(Object.entries(node).filter(([key]) => key !== "$ref"));
    const withSiblings = (placed: JsonObject): JsonObject => ({ ...siblings, ...placed });

    // A reference from an external file back into the root document becomes local.
    if (targetFile === this.rootPath) {
      return withSiblings({ $ref: `#${fragment}` });
    }
    const targetKey = `${targetFile}#${fragment}`;
    const alreadyPlaced = this.placedTargets.get(targetKey);
    if (alreadyPlaced !== undefined) {
      return withSiblings({ $ref: alreadyPlaced });
    }
    const target = await this.resolveTarget(targetFile, fragment, reference);

    if (placement !== undefined && "hoist" in placement) {
      const section = placement.hoist;
      const name = this.reserveName(section, nameFor(targetFile, fragment));
      const localReference = `#/components/${section}/${escapePointerToken(name)}`;
      // Registered before the content is walked, so a reference cycle across files ends here.
      this.placedTargets.set(targetKey, localReference);
      // A placeholder keeps the components in reference order: this one before those its content hoists.
      this.hoisted.get(section)!.set(name, undefined);
      const walked = await this.walk(target, targetFile, kind, undefined, undefined);
      this.hoisted.get(section)!.set(name, walked);
      return withSiblings({ $ref: localReference });
    }
    if (placement !== undefined && "define" in placement) {
      this.placedTargets.set(targetKey, placement.define);
    }
    if (this.inlining.has(targetKey)) {
      throw new Error(`$ref cycle through ${reference} at a position that is inlined (a path item or similar); move the cycle into components`);
    }
    this.inlining.add(targetKey);
    const inlined = await this.walk(target, targetFile, kind, undefined, undefined);
    this.inlining.delete(targetKey);
    return isObject(inlined) ? withSiblings(inlined) : inlined;
  }

  private checkInsideRoot(targetFile: string, reference: string): void {
    // Real paths, so a symbolic link inside the root cannot lead outside it. A missing file fails here with its path.
    let realTarget: string;
    try {
      realTarget = realpathSync(targetFile);
    } catch {
      throw new Error(`$ref "${reference}" does not resolve: cannot read ${targetFile}`);
    }
    const fromRoot = relative(realpathSync(this.refRoot), realTarget);
    if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
      throw new Error(`$ref "${reference}" points outside the reference root ${this.refRoot}; widen it with --ref-root (config "refRoot") if that file is trusted`);
    }
  }

  private async resolveTarget(targetFile: string, fragment: string, reference: string): Promise<unknown> {
    let current: unknown = await this.load(targetFile);
    if (fragment === "" || fragment === "/") {
      return current;
    }
    for (const token of fragment.replace(/^\//, "").split("/")) {
      const key = unescapePointerToken(decodeURIComponent(token));
      if (!isObject(current) && !Array.isArray(current)) {
        throw new Error(`$ref "${reference}" does not resolve: no "${key}" in ${targetFile}`);
      }
      const container = current as Record<string, unknown>;
      if (!Object.hasOwn(container, key)) {
        throw new Error(`$ref "${reference}" does not resolve: no "${key}" in ${targetFile}`);
      }
      current = container[key];
    }
    return current;
  }

  private reserveName(section: string, wanted: string): string {
    let names = this.usedNames.get(section);
    if (names === undefined) {
      names = new Set();
      this.usedNames.set(section, names);
    }
    if (!this.hoisted.has(section)) {
      this.hoisted.set(section, new Map());
    }
    let name = wanted;
    for (let suffix = 2; names.has(name); suffix++) {
      name = `${wanted}${suffix}`;
    }
    names.add(name);
    return name;
  }
}

/** The pointer's last token, else the file name without extension, reduced to the characters component keys allow. */
function nameFor(targetFile: string, fragment: string): string {
  const tokens = fragment.split("/").filter((token) => token !== "");
  const raw = tokens.length > 0 ? unescapePointerToken(decodeURIComponent(tokens[tokens.length - 1]!)) : basename(targetFile, extname(targetFile));
  const name = raw.replace(COMPONENT_KEY_INVALID, "_");
  return name === "" ? "_" : name;
}

/** True WHEN some `$ref` (or discriminator mapping) in the document points at another file. */
function hasExternalReference(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some(hasExternalReference);
  }
  if (!isObject(node)) {
    return false;
  }
  if (typeof node.$ref === "string" && !node.$ref.startsWith("#")) {
    return true;
  }
  if (isObject(node.discriminator) && isObject(node.discriminator.mapping)) {
    const pointsAtFile = Object.values(node.discriminator.mapping).some((target) => typeof target === "string" && !target.startsWith("#") && /\.(ya?ml|json)(#|$)/.test(target));
    if (pointsAtFile) {
      return true;
    }
  }
  return Object.values(node).some(hasExternalReference);
}

/**
 * The document with every external reference bundled in. Returns the input unchanged WHEN it has none, so
 * single-file documents take no extra pass. `refRoot` defaults to the root document's directory.
 */
export async function bundle(document: JsonObject, documentPath: string, refRoot?: string): Promise<JsonObject> {
  if (!hasExternalReference(document)) {
    return document;
  }
  const rootPath = resolvePath(documentPath);
  return new Bundler(document, rootPath, resolvePath(refRoot ?? dirname(rootPath))).run();
}
