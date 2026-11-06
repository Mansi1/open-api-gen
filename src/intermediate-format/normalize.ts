// Every 3.0 / 3.1 / 3.2 difference ends here: the output is one version-independent model, so naming, transform
// planning and Stage 2 never branch on the OpenAPI version.
// VERIFIED: test/normalize.test.ts and the golden intermediate-format files cover 3.0, 3.1 and 3.2 fixtures.
import type { ServiceFor } from "./config.ts";
import type { OpenApiVersion } from "./load.ts";
import { camel, kebab, pascal } from "./naming.ts";
import { deref, escapePointerToken, isRef, mergePathItem, refPointer, resolve, unescapePointerToken } from "./refs.ts";
import type {
  Body, Constraints, Declaration, DeclarationKind, Diagnostic, Discriminator, IntermediateFormat, Operation, Parameter, ParameterGroup,
  Incoming, ParameterLocation, Property, Response, Scalar, SecurityScheme, Server, ServerVariable, Service, TypeNode,
} from "./types.ts";

// The ONE module that knows how OpenAPI 3.0, 3.1 and 3.2 differ. Everything after it sees only the intermediate format.

type JsonObject = Record<string, unknown>;

type NormalizeContext = {
  document: JsonObject;
  version: OpenApiVersion;
  /** JSON Pointer of a schema → declaration name, so `$ref`s become name references and recursion terminates. */
  namesByPointer: Map<string, string>;
  declarations: Map<string, Declaration>;
  warnings: Diagnostic[];
  securitySchemes: Record<string, SecurityScheme>;
  incoming: Incoming[];
  /** Undefined scheme names already warned about, so a spec using one everywhere gets one warning, not hundreds. */
  undefinedSchemeNames: Set<string>;
};

const STANDARD_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const UNSUPPORTED_KEYWORDS = ["if", "then", "else", "not", "patternProperties", "dependentSchemas", "dependentRequired", "propertyNames", "contains", "unevaluatedProperties", "unevaluatedItems"];
const CONSTRAINT_KEYWORDS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "format", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties"] as const;
const ANNOTATION_KEYWORDS = ["description", "summary", "title", "deprecated", "readOnly", "writeOnly", "example", "examples", "default", "$comment"];
// Preferred request and response media types, best supported by the generated client first.
const MEDIA_TYPE_PREFERENCE = [/^application\/(.+\+)?json$/, /^multipart\/form-data$/, /^application\/x-www-form-urlencoded$/, /^application\/octet-stream$/, /^text\//];
// Path tokens that carry no meaning in a generated type name.
const STRUCTURAL_TOKENS = ["components", "schemas", "$defs", "definitions", "properties", "items", "paths", "content", "schema"];

/** Builds the intermediate format skeleton: declarations, services, operations. Transforms (codecs, renames) are added later by planTransforms. */
export function normalize(document: JsonObject, version: OpenApiVersion, sourcePath: string, serviceFor?: ServiceFor): IntermediateFormat {
  const context: NormalizeContext = { document, version, namesByPointer: new Map(), declarations: new Map(), warnings: [], securitySchemes: normalizeSecuritySchemes(document), undefinedSchemeNames: new Set(), incoming: [] };
  const components = (document.components ?? {}) as JsonObject;
  const schemas = (components.schemas ?? {}) as JsonObject;

  // Register every component name first, so references to components defined later resolve to names.
  for (const schemaKey of Object.keys(schemas)) {
    const pointer = componentPointer(schemaKey);
    context.namesByPointer.set(pointer, uniqueName(context, pascal(schemaKey), pointer));
  }
  for (const [schemaKey, schema] of Object.entries(schemas)) {
    const pointer = componentPointer(schemaKey);
    addDeclaration(context, context.namesByPointer.get(pointer)!, "components", schema, pointer);
  }

  const services = normalizeServices(context, serviceFor);
  checkExportedNames([...context.declarations.values()], services);
  const info = (document.info ?? {}) as JsonObject;
  return {
    intermediateFormatVersion: 1,
    source: {
      path: sourcePath,
      openapi: String(document.openapi),
      title: String(info.title ?? ""),
      version: String(info.version ?? ""),
      ...optionalText("description", info.description),
    },
    servers: normalizeServers(document.servers),
    securitySchemes: context.securitySchemes,
    declarations: [...context.declarations.values()],
    services,
    incoming: context.incoming,
    hooks: {},
    warnings: context.warnings,
  };
}

/** Top-level servers as plain data; the spec validation already checked their shape. */
function normalizeServers(servers: unknown): Server[] {
  if (!Array.isArray(servers)) {
    return [];
  }
  const result: Server[] = [];
  for (const server of servers as JsonObject[]) {
    const normalizedServer: Server = { url: String(server.url), ...optionalText("description", server.description) };
    const variables = (server.variables ?? {}) as Record<string, JsonObject>;
    const variableEntries = Object.entries(variables);
    if (variableEntries.length > 0) {
      normalizedServer.variables = {};
      for (const [variableName, variable] of variableEntries) {
        const normalizedVariable: ServerVariable = { default: String(variable.default), ...optionalText("description", variable.description) };
        if (Array.isArray(variable.enum)) {
          normalizedVariable.enum = variable.enum.map((value: unknown) => String(value));
        }
        normalizedServer.variables[variableName] = normalizedVariable;
      }
    }
    result.push(normalizedServer);
  }
  return result;
}

function componentPointer(schemaKey: string): string {
  return `/components/schemas/${escapePointerToken(schemaKey)}`;
}

// ---------------------------------------------------------------- declarations

function isNameTaken(context: NormalizeContext, name: string): boolean {
  if (context.declarations.has(name)) {
    return true;
  }
  for (const usedName of context.namesByPointer.values()) {
    if (usedName === name) {
      return true;
    }
  }
  return false;
}

function uniqueName(context: NormalizeContext, wantedName: string, pointer: string): string {
  if (!isNameTaken(context, wantedName)) {
    return wantedName;
  }
  let suffix = 1;
  while (isNameTaken(context, `${wantedName}_${suffix}`)) {
    suffix++;
  }
  const replacement = `${wantedName}_${suffix}`;
  context.warnings.push({ pointer, message: `type name "${wantedName}" is already used, generated "${replacement}" instead` });
  return replacement;
}

// Named addDeclaration, not declare: Bun drops statements that start with `declare(` (see VERIFY rule ts.no-declare-call).
function addDeclaration(context: NormalizeContext, name: string, kind: DeclarationKind, schema: unknown, pointer: string): string {
  const schemaObject = asObject(schema);
  // Reserve the name before converting, so recursive references to this pointer find it.
  context.namesByPointer.set(pointer, name);
  const declaration: Declaration = {
    name,
    kind,
    source: schema,
    pointer,
    type: { kind: "unknown" },
    transformed: false,
    runtime: false,
    ...optionalText("description", schemaObject.description),
    ...optionalFlag("deprecated", schemaObject.deprecated),
  };
  context.declarations.set(name, declaration);
  declaration.type = convertSchema(context, schema, pointer, name, kind, true);
  // The description belongs to the declaration, not to its type node.
  delete declaration.type.description;
  return name;
}

/** Inline enums and inline objects with properties get their own declaration named `<Parent><Prop>`, as dist3 does. */
function isExtractable(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null || isRef(schema)) {
    return false;
  }
  const schemaObject = schema as JsonObject;
  if (Array.isArray(schemaObject.enum)) {
    return true;
  }
  if (typeof schemaObject.properties !== "object" || schemaObject.properties === null) {
    return false;
  }
  return Object.keys(schemaObject.properties).length > 0;
}

// ---------------------------------------------------------------- schemas

/**
 * Converts one Schema Object.
 * `nameHint` names extracted inline declarations. `isRoot` disables extraction at this level: for the schema
 * that IS a declaration, and for allOf/oneOf/anyOf members, which stay inline.
 */
function convertSchema(context: NormalizeContext, schema: unknown, pointer: string, nameHint: string, kind: DeclarationKind, isRoot = false): TypeNode {
  if (schema === true || schema === undefined) {
    return { kind: "unknown" };
  }
  if (schema === false) {
    return { kind: "never" };
  }
  if (typeof schema !== "object" || schema === null) {
    return { kind: "unknown" };
  }
  const schemaObject = schema as JsonObject;
  const annotations = { ...optionalText("description", schemaObject.description), ...optionalFlag("deprecated", schemaObject.deprecated) };

  if (isRef(schema)) {
    return convertReference(context, schema.$ref, schemaObject, pointer, nameHint, kind, annotations);
  }

  if (!isRoot && isExtractable(schemaObject)) {
    let name = context.namesByPointer.get(pointer);
    if (name === undefined) {
      name = addDeclaration(context, uniqueName(context, nameHint, pointer), kind, schemaObject, pointer);
    }
    return { kind: "ref", name, ...annotations };
  }

  for (const keyword of UNSUPPORTED_KEYWORDS) {
    if (keyword in schemaObject) {
      context.warnings.push({ pointer, message: `keyword "${keyword}" is not supported; it is ignored, so types and validation accept more than the schema allows` });
    }
  }

  const typed = convertTypedSchema(context, schemaObject, pointer, nameHint, kind);
  return { ...addNullable(context, schemaObject, typed), ...annotations };
}

function convertReference(
  context: NormalizeContext,
  ref: string,
  schemaObject: JsonObject,
  pointer: string,
  nameHint: string,
  kind: DeclarationKind,
  annotations: { description?: string; deprecated?: true },
): TypeNode {
  const target = referenceNode(context, ref, pointer);
  // 3.1+ allows keywords next to $ref; they apply in addition to the target.
  const siblings = Object.fromEntries(Object.entries(schemaObject).filter(([key]) => key !== "$ref"));
  const onlyAnnotations = Object.keys(siblings).every((key) => ANNOTATION_KEYWORDS.includes(key) || key.startsWith("x-"));
  if (onlyAnnotations) {
    return { ...target, ...annotations };
  }
  const siblingType = convertSchema(context, siblings, pointer, nameHint, kind);
  return { kind: "intersection", members: [target, siblingType], ...optionalText("description", schemaObject.description) };
}

function convertTypedSchema(context: NormalizeContext, schemaObject: JsonObject, pointer: string, nameHint: string, kind: DeclarationKind): TypeNode {
  if ("const" in schemaObject) {
    return { kind: "literal", value: schemaObject.const as Scalar };
  }
  if (Array.isArray(schemaObject.enum)) {
    return { kind: "enum", values: schemaObject.enum as Scalar[] };
  }

  const parts: TypeNode[] = [];
  if (Array.isArray(schemaObject.allOf)) {
    schemaObject.allOf.forEach((member, index) => {
      parts.push(convertSchema(context, member, `${pointer}/allOf/${index}`, nameHint, kind, true));
    });
  }
  for (const mode of ["oneOf", "anyOf"] as const) {
    const memberSchemas = schemaObject[mode];
    if (!Array.isArray(memberSchemas)) {
      continue;
    }
    const members = memberSchemas.map((member, index) => {
      // The first member shares the hint; later ones are numbered from 2, so extracted names stay distinct.
      const memberHint = index === 0 ? nameHint : `${nameHint}${index + 1}`;
      return convertSchema(context, member, `${pointer}/${mode}/${index}`, memberHint, kind, true);
    });
    parts.push({ kind: "union", mode, members, ...discriminatorOf(context, schemaObject, members) });
  }

  const types = typeList(schemaObject);
  const hasOwnType = types.length > 0 || hasObjectKeywords(schemaObject) || hasArrayKeywords(schemaObject);
  if (hasOwnType) {
    parts.push(convertOwnType(context, schemaObject, types, pointer, nameHint, kind));
  }

  if (parts.length === 0) {
    return { kind: "unknown" };
  }
  if (parts.length === 1) {
    return parts[0]!;
  }
  return { kind: "intersection", members: parts };
}

/** The schema's own `type`, without composition keywords. Several types (3.1 `type: [a, b]`) become a union. */
function convertOwnType(context: NormalizeContext, schemaObject: JsonObject, types: string[], pointer: string, nameHint: string, kind: DeclarationKind): TypeNode {
  let impliedTypes = types;
  if (impliedTypes.length === 0) {
    impliedTypes = hasObjectKeywords(schemaObject) ? ["object"] : ["array"];
  }
  const nodes = impliedTypes.map((type) => convertSingleType(context, schemaObject, type, pointer, nameHint, kind));
  if (nodes.length === 1) {
    return nodes[0]!;
  }
  return { kind: "union", mode: "anyOf", members: nodes };
}

function convertSingleType(context: NormalizeContext, schemaObject: JsonObject, type: string, pointer: string, nameHint: string, kind: DeclarationKind): TypeNode {
  const constraints = constraintsOf(context, schemaObject, pointer);
  switch (type) {
    case "string":
      if (schemaObject.format === "binary") {
        return { kind: "binary" };
      }
      return { kind: "string", constraints };
    case "integer":
    case "number":
      return { kind: "number", integer: type === "integer", constraints };
    case "boolean":
      return { kind: "boolean" };
    case "null":
      return { kind: "null" };
    case "array":
      return convertArray(context, schemaObject, constraints, pointer, nameHint, kind);
    case "object":
      return convertObject(context, schemaObject, constraints, pointer, nameHint, kind);
    default:
      context.warnings.push({ pointer, message: `unknown type "${type}" treated as unknown` });
      return { kind: "unknown" };
  }
}

function convertArray(context: NormalizeContext, schemaObject: JsonObject, constraints: Constraints, pointer: string, nameHint: string, kind: DeclarationKind): TypeNode {
  if (Array.isArray(schemaObject.prefixItems)) {
    const prefix = schemaObject.prefixItems.map((item, index) => convertSchema(context, item, `${pointer}/prefixItems/${index}`, `${nameHint}${index}`, kind));
    let rest: TypeNode | false | null;
    if (schemaObject.items === false) {
      rest = false;
    } else if (schemaObject.items === undefined) {
      rest = null;
    } else {
      rest = convertSchema(context, schemaObject.items, `${pointer}/items`, nameHint, kind);
    }
    return { kind: "tuple", prefix, rest, constraints };
  }
  // Array items share the parent's name (dist3: `shipTypes: Array<ShipyardShipTypes>`), unless that name belongs to
  // the declaration this array is part of: a schema that is itself an array names its item `<Name>Item`.
  const itemHint = isNameOfEnclosingDeclaration(context, nameHint, pointer) ? `${nameHint}Item` : nameHint;
  const items = convertSchema(context, schemaObject.items, `${pointer}/items`, itemHint, kind);
  return { kind: "array", items, constraints };
}

/** True WHEN `name` is the declaration at `pointer` or at one of its ancestors. */
function isNameOfEnclosingDeclaration(context: NormalizeContext, name: string, pointer: string): boolean {
  for (const [declarationPointer, declarationName] of context.namesByPointer) {
    if (declarationName === name && (pointer === declarationPointer || pointer.startsWith(`${declarationPointer}/`))) {
      return true;
    }
  }
  return false;
}

function convertObject(context: NormalizeContext, schemaObject: JsonObject, constraints: Constraints, pointer: string, nameHint: string, kind: DeclarationKind): TypeNode {
  const requiredNames = new Set(Array.isArray(schemaObject.required) ? (schemaObject.required as string[]) : []);
  const propertySchemas = (schemaObject.properties ?? {}) as JsonObject;
  const properties: Property[] = Object.keys(propertySchemas)
    .sort()
    .map((propertyName) => {
      const propertySchema = asObject(propertySchemas[propertyName]);
      const propertyPointer = `${pointer}/properties/${escapePointerToken(propertyName)}`;
      const type = convertSchema(context, propertySchemas[propertyName], propertyPointer, `${nameHint}${pascal(propertyName)}`, kind);
      return {
        name: propertyName,
        appName: propertyName,
        required: requiredNames.has(propertyName),
        type: withoutAnnotations(type),
        ...optionalText("description", propertySchema.description),
        ...optionalFlag("deprecated", propertySchema.deprecated),
        ...optionalFlag("readOnly", propertySchema.readOnly),
        ...optionalFlag("writeOnly", propertySchema.writeOnly),
      };
    });

  const additionalSchema = schemaObject.additionalProperties;
  let additional: TypeNode | boolean;
  if (additionalSchema === undefined || additionalSchema === true) {
    additional = true;
  } else if (additionalSchema === false) {
    additional = false;
  } else {
    additional = convertSchema(context, additionalSchema, `${pointer}/additionalProperties`, `${nameHint}Value`, kind);
  }
  return { kind: "object", properties, additional, constraints };
}

function referenceNode(context: NormalizeContext, ref: string, fromPointer: string): TypeNode {
  const targetPointer = refPointer(ref);
  const knownName = context.namesByPointer.get(targetPointer);
  if (knownName !== undefined) {
    return { kind: "ref", name: knownName };
  }
  // A reference into something that is not a component (`$defs`, a path's inline schema): declare it on first use.
  const schema = resolve(context.document, ref);
  const tokens = targetPointer.split("/").slice(1).map(unescapePointerToken);
  const meaningfulTokens = tokens.filter((token) => !STRUCTURAL_TOKENS.includes(token));
  const name = uniqueName(context, pascal(meaningfulTokens.join(" ")), fromPointer);
  return { kind: "ref", name: addDeclaration(context, name, "components", schema, targetPointer) };
}

/** 3.0 `nullable: true` adds null; 3.1+ uses `type: [x, "null"]`, which typeList already handles. */
function addNullable(context: NormalizeContext, schemaObject: JsonObject, node: TypeNode): TypeNode {
  if (context.version !== "3.0" || schemaObject.nullable !== true) {
    return node;
  }
  if (node.kind === "enum") {
    if (node.values.includes(null)) {
      return node;
    }
    return { ...node, values: [...node.values, null] };
  }
  return { kind: "union", mode: "anyOf", members: [node, { kind: "null" }] };
}

function typeList(schemaObject: JsonObject): string[] {
  if (Array.isArray(schemaObject.type)) {
    return schemaObject.type as string[];
  }
  if (typeof schemaObject.type === "string") {
    return [schemaObject.type];
  }
  return [];
}

function hasObjectKeywords(schemaObject: JsonObject): boolean {
  return schemaObject.properties !== undefined || schemaObject.additionalProperties !== undefined || schemaObject.required !== undefined;
}

function hasArrayKeywords(schemaObject: JsonObject): boolean {
  return schemaObject.items !== undefined || schemaObject.prefixItems !== undefined;
}

function constraintsOf(context: NormalizeContext, schemaObject: JsonObject, pointer: string): Constraints {
  const constraints: Record<string, unknown> = {};
  for (const keyword of CONSTRAINT_KEYWORDS) {
    if (schemaObject[keyword] !== undefined) {
      constraints[keyword] = schemaObject[keyword];
    }
  }
  // 3.0: `exclusiveMinimum: true` modifies `minimum`; in JSON Schema 2020-12 the exclusive keyword is the bound itself.
  const exclusivePairs = [["exclusiveMinimum", "minimum"], ["exclusiveMaximum", "maximum"]] as const;
  for (const [exclusiveKeyword, boundKeyword] of exclusivePairs) {
    if (typeof constraints[exclusiveKeyword] !== "boolean") {
      continue;
    }
    if (constraints[exclusiveKeyword] === true && typeof constraints[boundKeyword] === "number") {
      constraints[exclusiveKeyword] = constraints[boundKeyword];
      delete constraints[boundKeyword];
    } else {
      delete constraints[exclusiveKeyword];
    }
  }
  if (typeof constraints.pattern === "string" && !isValidPattern(constraints.pattern)) {
    context.warnings.push({ pointer, message: `pattern ${JSON.stringify(constraints.pattern)} is not a valid regular expression; it is ignored` });
    delete constraints.pattern;
  }
  return constraints as Constraints;
}

function isValidPattern(pattern: string): boolean {
  try {
    new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
}

function discriminatorOf(context: NormalizeContext, schemaObject: JsonObject, members: TypeNode[]): { discriminator?: Discriminator } {
  const discriminator = schemaObject.discriminator as JsonObject | undefined;
  if (discriminator === undefined || typeof discriminator.propertyName !== "string") {
    return {};
  }
  const mapping: Record<string, string> = {};
  if (typeof discriminator.mapping === "object" && discriminator.mapping !== null) {
    for (const [value, target] of Object.entries(discriminator.mapping as Record<string, string>)) {
      // Mapping values are references or bare component names.
      const ref = target.startsWith("#") ? target : `#${componentPointer(target)}`;
      const node = referenceNode(context, ref, "");
      if (node.kind === "ref") {
        mapping[value] = node.name;
      }
    }
  }
  // Without an explicit mapping entry, the value is the component's key (the OpenAPI implicit mapping).
  for (const member of members) {
    if (member.kind !== "ref" || Object.values(mapping).includes(member.name)) {
      continue;
    }
    for (const [pointer, name] of context.namesByPointer) {
      if (name === member.name && pointer.startsWith("/components/schemas/")) {
        mapping[unescapePointerToken(pointer.slice("/components/schemas/".length))] = member.name;
        break;
      }
    }
  }
  return { discriminator: { property: discriminator.propertyName, mapping } };
}

/** Property and parameter descriptions live on the Property or Parameter; keep the type node free of a duplicate. */
function withoutAnnotations(node: TypeNode): TypeNode {
  const copy = { ...node };
  delete copy.description;
  delete copy.deprecated;
  return copy;
}

// ---------------------------------------------------------------- operations

function normalizeServices(context: NormalizeContext, serviceFor: ServiceFor | undefined): Service[] {
  const paths = (context.document.paths ?? {}) as JsonObject;
  const tagObjects = (context.document.tags ?? []) as JsonObject[];
  const tagOrder = tagObjects.map((tag) => String(tag.name));
  const tagDescriptions = new Map(tagObjects.map((tag) => [String(tag.name), tag.description as string | undefined]));
  const operationsByTag = new Map<string, Operation[]>();
  const usedOperationIds = new Set<string>();

  for (const [path, rawPathItem] of Object.entries(paths)) {
    const pathItemPointer = `/paths/${escapePointerToken(path)}`;
    const pathItem = mergePathItem(context.document, rawPathItem as JsonObject);
    for (const { method, operation, pointer } of operationsOf(context, pathItem, pathItemPointer)) {
      const normalized = normalizeOperation(context, { method, path, pathItem, pathItemPointer, operation, pointer, usedOperationIds });
      normalizeCallbacks(context, operation, normalized.operationId, pointer, usedOperationIds);
      // Grouping by tag: the first tag wins; untagged operations share one service. serviceFor may pick another group.
      const operationTags = Array.isArray(operation.tags) ? operation.tags.map((operationTag) => String(operationTag)) : [];
      const tag = chooseService(serviceFor, normalized, operationTags) ?? operationTags[0] ?? "";
      let tagOperations = operationsByTag.get(tag);
      if (tagOperations === undefined) {
        tagOperations = [];
        operationsByTag.set(tag, tagOperations);
      }
      tagOperations.push(normalized);
    }
  }

  normalizeWebhooks(context, usedOperationIds);

  const tags = [...operationsByTag.keys()].sort((first, second) => tagRank(tagOrder, first) - tagRank(tagOrder, second));
  const services: Service[] = [];
  const tagByServiceName = new Map<string, string>();
  const tagByProperty = new Map<string, string>();
  for (const tag of tags) {
    const name = serviceName(tag);
    const clashingTag = tagByServiceName.get(name.toLowerCase());
    if (clashingTag !== undefined) {
      throw new Error(`tags "${clashingTag}" and "${tag}" both map to service ${name}; rename one of them`);
    }
    tagByServiceName.set(name.toLowerCase(), tag);
    const property = serviceProperty(name);
    const tagWithProperty = tagByProperty.get(property);
    if (tagWithProperty !== undefined) {
      throw new Error(`tags "${tagWithProperty}" and "${tag}" both map to client property ${property}; rename one of them`);
    }
    tagByProperty.set(property, tag);
    const operations = operationsByTag.get(tag)!;
    makeMethodNamesUnique(operations);
    services.push({
      name,
      property,
      folder: tag === "" ? "default" : kebab(tag),
      ...optionalText("description", tagDescriptions.get(tag)),
      operations,
    });
  }
  return services;
}

/** Calls the user's serviceFor for one operation; names the operation in any error it throws or wrong value it returns. */
function chooseService(serviceFor: ServiceFor | undefined, operation: Operation, tags: string[]): string | undefined {
  if (serviceFor === undefined) {
    return undefined;
  }
  let chosen: unknown;
  try {
    chosen = serviceFor({
      operationId: operation.operationId,
      method: operation.method,
      path: operation.path,
      tags: [...tags],
      ...optionalText("summary", operation.summary),
      deprecated: operation.deprecated === true,
    });
  } catch (error) {
    throw new Error(`serviceFor failed for operation ${operation.operationId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (chosen !== undefined && typeof chosen !== "string") {
    throw new Error(`serviceFor must return a string or undefined, got ${typeof chosen} for operation ${operation.operationId}`);
  }
  return chosen;
}

/**
 * The generated index re-exports every declaration file and service, so their exported names must be unique:
 * a declaration's own name, `<Enum>Values` beside an enum, and each service class.
 */
function checkExportedNames(declarations: Declaration[], services: Service[]): void {
  const ownerByName = new Map<string, string>();
  const claim = (name: string, owner: string) => {
    const clashingOwner = ownerByName.get(name);
    if (clashingOwner !== undefined) {
      throw new Error(`${clashingOwner} and ${owner} both export ${name}; rename one of them (an overlay can rename a schema or tag)`);
    }
    ownerByName.set(name, owner);
  };
  for (const declaration of declarations) {
    claim(declaration.name, `schema ${declaration.pointer}`);
    if (declaration.type.kind === "enum") {
      claim(`${declaration.name}Values`, `the values of enum ${declaration.pointer}`);
    }
  }
  for (const service of services) {
    claim(service.name, `the service of tag folder "${service.folder}"`);
    claim(`${service.name}Errors`, `the error types of service ${service.name}`);
  }
}

/** `PetsService` → `pets`, `DefaultService` → `default`: the class name without its suffix, first letter lowercased. */
function serviceProperty(name: string): string {
  const stem = name.replace(/Service$/, "");
  if (stem === "") {
    return "service";
  }
  return stem.charAt(0).toLowerCase() + stem.slice(1);
}

function serviceName(tag: string): string {
  if (tag === "") {
    return "DefaultService";
  }
  // A tag like "Health Check Service" must not become HealthCheckServiceService.
  const base = pascal(tag).replace(/Service$/, "");
  if (base === "") {
    return "Service";
  }
  return `${base}Service`;
}

function operationsOf(context: NormalizeContext, pathItem: JsonObject, pathItemPointer: string): { method: string; operation: JsonObject; pointer: string }[] {
  const methods = [...STANDARD_METHODS];
  if (context.version === "3.2") {
    methods.push("query");
  }
  const found: { method: string; operation: JsonObject; pointer: string }[] = [];
  for (const method of methods) {
    if (pathItem[method] !== undefined) {
      found.push({ method: method.toUpperCase(), operation: pathItem[method] as JsonObject, pointer: `${pathItemPointer}/${method}` });
    }
  }
  const additional = pathItem.additionalOperations;
  if (context.version === "3.2" && typeof additional === "object" && additional !== null) {
    for (const [method, operation] of Object.entries(additional as JsonObject)) {
      found.push({ method, operation: operation as JsonObject, pointer: `${pathItemPointer}/additionalOperations/${escapePointerToken(method)}` });
    }
  }
  return found;
}

function tagRank(tagOrder: string[], tag: string): number {
  if (tag === "") {
    return Number.MAX_SAFE_INTEGER;
  }
  if (tagOrder.includes(tag)) {
    return tagOrder.indexOf(tag);
  }
  return tagOrder.length;
}

function makeMethodNamesUnique(operations: Operation[]): void {
  // A renamed method must not take a name that another operation already has, so every original name stays reserved.
  const originalNames = new Set(operations.map((operation) => operation.name));
  const usedNames = new Set<string>();
  for (const operation of operations) {
    if (usedNames.has(operation.name)) {
      let suffix = 2;
      while (usedNames.has(`${operation.name}${suffix}`) || originalNames.has(`${operation.name}${suffix}`)) {
        suffix++;
      }
      operation.name = `${operation.name}${suffix}`;
    }
    usedNames.add(operation.name);
  }
}

type OperationInput = {
  method: string;
  path: string;
  pathItem: JsonObject;
  pathItemPointer: string;
  operation: JsonObject;
  pointer: string;
  usedOperationIds: Set<string>;
};

function normalizeOperation(context: NormalizeContext, input: OperationInput): Operation {
  const { method, path, operation, pointer } = input;
  const operationId = uniqueOperationId(context, input);
  const typeBase = pascal(operationId);
  const { groups, querystring } = normalizeParameters(context, input, typeBase);

  let requestBody: Operation["requestBody"];
  if (operation.requestBody !== undefined) {
    const { value, pointer: refPointer } = deref(context.document, operation.requestBody);
    const requestBodyObject = value as JsonObject;
    const body = bodyOf(context, requestBodyObject.content as JsonObject | undefined, refPointer ?? `${pointer}/requestBody`, `${typeBase}Request`, "request");
    if (body !== undefined) {
      requestBody = { ...body, required: requestBodyObject.required === true };
    }
  }

  const { responses, success } = normalizeResponses(context, operation, pointer, typeBase);
  const security = normalizeSecurity(context, operation.security ?? context.document.security, pointer);
  const servers = normalizeServers(operation.servers ?? input.pathItem.servers);
  return {
    name: camel(operationId),
    operationId,
    method,
    path,
    ...optionalText("summary", operation.summary),
    ...optionalText("description", operation.description),
    ...optionalFlag("deprecated", operation.deprecated),
    parameters: groups,
    ...(querystring !== undefined ? { querystring } : {}),
    ...(requestBody !== undefined ? { requestBody } : {}),
    responses,
    success,
    security,
    ...(servers.length > 0 ? { servers } : {}),
  };
}

/** Security Requirement Objects → alternatives of scheme names. An alternative naming an undefined scheme is dropped, warned once per name at its first use. */
function normalizeSecurity(context: NormalizeContext, requirements: unknown, pointer: string): string[][] {
  if (!Array.isArray(requirements)) {
    return [];
  }
  const alternatives: string[][] = [];
  for (const requirement of requirements as JsonObject[]) {
    const schemeNames = Object.keys(requirement ?? {});
    const unknownName = schemeNames.find((schemeName) => context.securitySchemes[schemeName] === undefined);
    if (unknownName !== undefined) {
      if (!context.undefinedSchemeNames.has(unknownName)) {
        context.undefinedSchemeNames.add(unknownName);
        context.warnings.push({ pointer, message: `security requirement names undefined scheme "${unknownName}"; alternatives naming it are ignored here and everywhere else` });
      }
      continue;
    }
    alternatives.push(schemeNames);
  }
  return alternatives;
}

/** `components.securitySchemes` with references resolved; spec validation already checked their shape. */
function normalizeSecuritySchemes(document: JsonObject): Record<string, SecurityScheme> {
  const components = (document.components ?? {}) as JsonObject;
  const schemes = (components.securitySchemes ?? {}) as JsonObject;
  const result: Record<string, SecurityScheme> = {};
  for (const [schemeName, schemeValue] of Object.entries(schemes)) {
    const scheme = deref(document, schemeValue).value as JsonObject;
    const description = optionalText("description", scheme.description);
    if (scheme.type === "apiKey") {
      result[schemeName] = { type: "apiKey", in: scheme.in as "header" | "query" | "cookie", name: String(scheme.name), ...description };
    } else if (scheme.type === "http") {
      result[schemeName] = { type: "http", scheme: String(scheme.scheme).toLowerCase(), ...description };
    } else if (scheme.type === "oauth2" || scheme.type === "openIdConnect" || scheme.type === "mutualTLS") {
      result[schemeName] = { type: scheme.type, ...description };
    }
  }
  return result;
}

// ---------------------------------------------------------------- webhooks and callbacks

/** One incoming operation per method of a webhook's or callback's path item. */
function normalizeIncomingPathItem(
  context: NormalizeContext,
  rawPathItem: unknown,
  pathItemPointer: string,
  incoming: { kind: Incoming["kind"]; name: string; expression?: string; fallbackId: (method: string) => string },
  usedOperationIds: Set<string>,
): void {
  const pathItem = mergePathItem(context.document, deref(context.document, rawPathItem).value as JsonObject);
  for (const { method, operation, pointer } of operationsOf(context, pathItem, pathItemPointer)) {
    const declaredId = typeof operation.operationId === "string" && operation.operationId !== "" ? operation.operationId : incoming.fallbackId(method);
    const operationId = uniqueOperationId(context, { method, path: incoming.name, pathItem, pathItemPointer, operation: { ...operation, operationId: declaredId }, pointer, usedOperationIds });
    const normalized: Incoming = {
      kind: incoming.kind,
      operationId,
      name: incoming.name,
      method,
      ...(incoming.expression !== undefined ? { expression: incoming.expression } : {}),
      ...optionalText("summary", operation.summary),
      ...optionalText("description", operation.description),
      ...optionalFlag("deprecated", operation.deprecated),
    };
    if (operation.requestBody !== undefined) {
      const { value, pointer: refPointer } = deref(context.document, operation.requestBody);
      const requestBodyObject = value as JsonObject;
      const body = bodyOf(context, requestBodyObject.content as JsonObject | undefined, refPointer ?? `${pointer}/requestBody`, `${pascal(operationId)}Request`, "request");
      if (body !== undefined) {
        normalized.requestBody = { ...body, required: requestBodyObject.required === true };
      }
    }
    context.incoming.push(normalized);
  }
}

/** `webhooks` (OpenAPI 3.1+): name → path item. */
function normalizeWebhooks(context: NormalizeContext, usedOperationIds: Set<string>): void {
  const webhooks = (context.document.webhooks ?? {}) as JsonObject;
  for (const [webhookName, pathItem] of Object.entries(webhooks)) {
    const fallbackId = (method: string) => camel(`${method.toLowerCase()} ${webhookName}`);
    normalizeIncomingPathItem(context, pathItem, `/webhooks/${escapePointerToken(webhookName)}`, { kind: "webhook", name: webhookName, fallbackId }, usedOperationIds);
  }
}

/** An operation's `callbacks`: name → (runtime expression → path item). */
function normalizeCallbacks(context: NormalizeContext, operation: JsonObject, parentOperationId: string, pointer: string, usedOperationIds: Set<string>): void {
  const callbacks = (operation.callbacks ?? {}) as JsonObject;
  for (const [callbackName, callbackValue] of Object.entries(callbacks)) {
    const callback = deref(context.document, callbackValue).value as JsonObject;
    for (const [expression, pathItem] of Object.entries(callback)) {
      const pathItemPointer = `${pointer}/callbacks/${escapePointerToken(callbackName)}/${escapePointerToken(expression)}`;
      const name = `${parentOperationId}.${callbackName}`;
      const fallbackId = () => camel(`${parentOperationId} ${callbackName}`);
      normalizeIncomingPathItem(context, pathItem, pathItemPointer, { kind: "callback", name, expression, fallbackId }, usedOperationIds);
    }
  }
}

function uniqueOperationId(context: NormalizeContext, input: OperationInput): string {
  const declaredId = input.operation.operationId;
  let operationId = typeof declaredId === "string" && declaredId !== "" ? declaredId : derivedOperationId(input.method, input.path);
  if (input.usedOperationIds.has(operationId)) {
    context.warnings.push({ pointer: input.pointer, message: `operationId "${operationId}" is used more than once` });
    let suffix = 2;
    while (input.usedOperationIds.has(`${operationId}${suffix}`)) {
      suffix++;
    }
    operationId = `${operationId}${suffix}`;
  }
  input.usedOperationIds.add(operationId);
  return operationId;
}

/** `GET /pets/{petId}/toys` → `getPetsByPetIdToys`. */
function derivedOperationId(method: string, path: string): string {
  const segments = path.split("/").map((segment) => {
    const isTemplate = /^\{.+\}$/.test(segment);
    return isTemplate ? `by ${segment.slice(1, -1)}` : segment;
  });
  return camel(`${method.toLowerCase()} ${segments.join(" ")}`);
}

// OpenAPI: header parameters named Accept, Content-Type or Authorization are ignored.
const IGNORED_HEADERS = ["accept", "content-type", "authorization"];
const PARAMETER_LOCATIONS: ParameterLocation[] = ["path", "query", "header", "cookie"];

function normalizeParameters(context: NormalizeContext, input: OperationInput, typeBase: string): { groups: Partial<Record<ParameterLocation, ParameterGroup>>; querystring: Operation["querystring"] } {
  // Operation parameters override path-level ones with the same name and location.
  const parametersByKey = new Map<string, { parameter: JsonObject; pointer: string }>();
  const sources = [
    { list: input.pathItem.parameters, basePointer: input.pathItemPointer },
    { list: input.operation.parameters, basePointer: input.pointer },
  ];
  for (const { list, basePointer } of sources) {
    if (!Array.isArray(list)) {
      continue;
    }
    list.forEach((rawParameter, index) => {
      const parameter = deref(context.document, rawParameter).value as JsonObject;
      parametersByKey.set(`${String(parameter.in)}:${String(parameter.name)}`, { parameter, pointer: `${basePointer}/parameters/${index}` });
    });
  }

  const groups: Partial<Record<ParameterLocation, ParameterGroup>> = {};
  let querystring: Operation["querystring"];
  for (const { parameter, pointer } of parametersByKey.values()) {
    const location = String(parameter.in);
    if (location === "querystring") {
      const [contentType, mediaType] = pickMediaType(parameter.content as JsonObject | undefined);
      querystring = {
        name: String(parameter.name),
        contentType: contentType ?? "application/x-www-form-urlencoded",
        type: convertSchema(context, mediaType?.schema, `${pointer}/content`, `${typeBase}Querystring`, "parameter"),
        required: parameter.required === true,
      };
      continue;
    }
    if (!PARAMETER_LOCATIONS.includes(location as ParameterLocation)) {
      continue;
    }
    if (location === "header" && IGNORED_HEADERS.includes(String(parameter.name).toLowerCase())) {
      continue;
    }
    const parameterLocation = location as ParameterLocation;
    const declarationName = `${typeBase}${pascal(parameterLocation)}Parameter`;
    let group = groups[parameterLocation];
    if (group === undefined) {
      group = { declaration: declarationName, required: false, parameters: [] };
      groups[parameterLocation] = group;
    }
    const normalized = normalizeParameter(context, parameter, parameterLocation, pointer, declarationName);
    group.parameters.push(normalized);
    group.required = group.required || normalized.required;
  }

  for (const [location, group] of Object.entries(groups) as [ParameterLocation, ParameterGroup][]) {
    group.parameters.sort((first, second) => compareStrings(first.name, second.name));
    group.declaration = uniqueName(context, group.declaration, input.pointer);
    addParameterDeclaration(context, group, location, parametersByKey, input.pointer);
  }
  return { groups, querystring };
}

function normalizeParameter(context: NormalizeContext, parameter: JsonObject, location: ParameterLocation, pointer: string, declarationName: string): Parameter {
  let schema = parameter.schema;
  if (schema === undefined) {
    schema = pickMediaType(parameter.content as JsonObject | undefined)[1]?.schema;
  }
  let style: Parameter["style"];
  if (typeof parameter.style === "string") {
    style = parameter.style as Parameter["style"];
  } else if (location === "query" || location === "cookie") {
    style = "form";
  } else {
    style = "simple";
  }
  const explode = typeof parameter.explode === "boolean" ? parameter.explode : style === "form";
  const type = convertSchema(context, schema, `${pointer}/schema`, `${declarationName}${pascal(String(parameter.name))}`, "parameter");
  return {
    name: String(parameter.name),
    required: location === "path" || parameter.required === true,
    type: withoutAnnotations(type),
    style,
    explode,
    ...optionalText("description", parameter.description),
    ...optionalFlag("deprecated", parameter.deprecated),
  };
}

/** Each parameter group is also an interface (`<Op>PathParameter`, ...), as in dist3. */
function addParameterDeclaration(
  context: NormalizeContext,
  group: ParameterGroup,
  location: ParameterLocation,
  parametersByKey: Map<string, { parameter: JsonObject; pointer: string }>,
  operationPointer: string,
): void {
  const properties: Property[] = group.parameters.map((parameter) => ({
    name: parameter.name,
    appName: parameter.name,
    required: parameter.required,
    type: parameter.type,
    ...optionalText("description", parameter.description),
    ...optionalFlag("deprecated", parameter.deprecated),
  }));
  const sourceProperties: JsonObject = {};
  for (const parameter of group.parameters) {
    sourceProperties[parameter.name] = parametersByKey.get(`${location}:${parameter.name}`)?.parameter.schema ?? {};
  }
  const requiredNames = group.parameters.filter((parameter) => parameter.required).map((parameter) => parameter.name);
  context.declarations.set(group.declaration, {
    name: group.declaration,
    kind: "parameter",
    source: { type: "object", required: requiredNames, properties: sourceProperties },
    pointer: operationPointer,
    type: { kind: "object", properties, additional: false, constraints: {} },
    transformed: false,
    runtime: false,
  });
}

function normalizeResponses(context: NormalizeContext, operation: JsonObject, pointer: string, typeBase: string): { responses: Response[]; success: string[] } {
  const rawResponses = (operation.responses ?? {}) as JsonObject;
  const statuses = Object.keys(rawResponses).sort(compareStatuses);
  const success = statuses.filter((status) => status.startsWith("2"));
  if (success.length === 0 && statuses.includes("default")) {
    success.push("default");
  }

  const responses: Response[] = [];
  for (const status of statuses) {
    const { value, pointer: refPointer } = deref(context.document, rawResponses[status]);
    const response = value as JsonObject;
    // The first success response is `<Op>Response` (dist3); others carry their status.
    let nameHint: string;
    if (status === success[0]) {
      nameHint = `${typeBase}Response`;
    } else if (status === "default") {
      nameHint = `${typeBase}ResponseDefault`;
    } else {
      nameHint = `${typeBase}Response${status.toUpperCase()}`;
    }
    const responsePointer = refPointer ?? `${pointer}/responses/${escapePointerToken(status)}`;
    const body = bodyOf(context, response.content as JsonObject | undefined, responsePointer, nameHint, "response");
    responses.push({
      status,
      contentType: body?.contentType ?? "",
      stream: body?.stream ?? false,
      ...(body?.type !== undefined ? { type: body.type } : {}),
      ...optionalText("description", response.description),
    });
  }
  return { responses, success };
}

/** Status codes in order, `default` last. */
function compareStatuses(first: string, second: string): number {
  if (first === "default") {
    return 1;
  }
  if (second === "default") {
    return -1;
  }
  return first.localeCompare(second);
}

function bodyOf(context: NormalizeContext, content: JsonObject | undefined, pointer: string, nameHint: string, kind: DeclarationKind): Body | undefined {
  const [contentType, mediaType] = pickMediaType(content);
  if (contentType === undefined) {
    return undefined;
  }
  const mediaTypePointer = `${pointer}/content/${escapePointerToken(contentType)}`;
  if (mediaType?.itemSchema !== undefined) {
    return { contentType, stream: true, type: bodyType(context, mediaType.itemSchema, `${mediaTypePointer}/itemSchema`, `${nameHint}Item`, kind) };
  }
  if (mediaType?.schema === undefined) {
    return { contentType, stream: false };
  }
  return { contentType, stream: false, type: bodyType(context, mediaType.schema, `${mediaTypePointer}/schema`, nameHint, kind) };
}

/** A body schema that is an inline object or enum becomes the `<Op>Request` or `<Op>Response` declaration itself. */
function bodyType(context: NormalizeContext, schema: unknown, pointer: string, name: string, kind: DeclarationKind): TypeNode {
  if (isExtractable(schema)) {
    let declaredName = context.namesByPointer.get(pointer);
    if (declaredName === undefined) {
      declaredName = addDeclaration(context, uniqueName(context, name, pointer), kind, schema, pointer);
    }
    return { kind: "ref", name: declaredName };
  }
  return withoutAnnotations(convertSchema(context, schema, pointer, name, kind));
}

function pickMediaType(content: JsonObject | undefined): [string | undefined, JsonObject | undefined] {
  const contentTypes = Object.keys(content ?? {});
  const baseType = (contentType: string) => contentType.split(";")[0]!.trim();
  let chosen: string | undefined;
  for (const preference of MEDIA_TYPE_PREFERENCE) {
    chosen = contentTypes.find((contentType) => preference.test(baseType(contentType)));
    if (chosen !== undefined) {
      break;
    }
  }
  chosen ??= contentTypes[0];
  if (chosen === undefined) {
    return [undefined, undefined];
  }
  return [chosen, asObject(content![chosen])];
}

// ---------------------------------------------------------------- helpers

function asObject(value: unknown): JsonObject {
  if (typeof value === "object" && value !== null) {
    return value as JsonObject;
  }
  return {};
}

function compareStrings(first: string, second: string): number {
  if (first < second) {
    return -1;
  }
  if (first > second) {
    return 1;
  }
  return 0;
}

function optionalText<Key extends string>(key: Key, value: unknown): { [Name in Key]?: string } {
  if (typeof value === "string" && value !== "") {
    return { [key]: value } as { [Name in Key]: string };
  }
  return {};
}

function optionalFlag<Key extends string>(key: Key, value: unknown): { [Name in Key]?: true } {
  if (value === true) {
    return { [key]: true } as { [Name in Key]: true };
  }
  return {};
}
