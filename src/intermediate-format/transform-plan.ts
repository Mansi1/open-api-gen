// Records every wire ↔ App difference in the intermediate format, so Stage 2 renders decisions instead of making them.
// VERIFIED: test/transform-plan.test.ts covers precedence, collisions and untouched map keys.
import type { Config } from "./config.ts";
import { camelProperty } from "./naming.ts";
import type { Codec, Declaration, IntermediateFormat, TypeNode } from "./types.ts";

/**
 * Decides every wire ↔ App difference (T1 formats, T2 naming, T3 hooks) and records it in the intermediate format:
 * `codec` on type nodes, `appName` on properties, and the `transformed` and `runtime` flags on declarations.
 * Precedence for one value: `schema:<Name>` hook > `format:<name>` hook > built-in format codec.
 * Parameters keep wire names and types; only bodies are transformed.
 */
export function planTransforms(input: IntermediateFormat, config: Config): IntermediateFormat {
  const intermediateFormat = structuredClone(input);
  intermediateFormat.hooks = { ...config.transformers };
  const declarationsByName = new Map(intermediateFormat.declarations.map((declaration) => [declaration.name, declaration]));

  for (const hookKey of Object.keys(intermediateFormat.hooks)) {
    if (!hookKey.startsWith("schema:")) {
      continue;
    }
    const schemaName = hookKey.slice("schema:".length);
    const declaration = declarationsByName.get(schemaName);
    if (declaration === undefined) {
      throw new Error(`config: transformer "${hookKey}": no schema named ${schemaName}`);
    }
    declaration.type.codec = { kind: "hook", hook: hookKey };
  }

  const bodyTypes: TypeNode[] = [];
  for (const service of intermediateFormat.services) {
    for (const operation of service.operations) {
      if (operation.requestBody?.type !== undefined) {
        bodyTypes.push(operation.requestBody.type);
      }
      for (const response of operation.responses) {
        if (response.type !== undefined) {
          bodyTypes.push(response.type);
        }
      }
    }
  }

  // Webhook and callback payloads are read by parseWebhook, so they need validators and codecs like responses.
  for (const incoming of intermediateFormat.incoming) {
    if (incoming.requestBody?.type !== undefined) {
      bodyTypes.push(incoming.requestBody.type);
    }
  }

  for (const declaration of intermediateFormat.declarations) {
    if (declaration.kind !== "parameter") {
      planNode(declaration.type, declaration.name, config, intermediateFormat);
    }
  }
  for (const bodyType of bodyTypes) {
    planNode(bodyType, "", config, intermediateFormat);
  }

  markTransformed(intermediateFormat.declarations, declarationsByName);
  markRuntime(bodyTypes, declarationsByName);
  return intermediateFormat;
}

function planNode(node: TypeNode, ownerName: string, config: Config, intermediateFormat: IntermediateFormat): void {
  if (node.codec === undefined) {
    const codec = codecFor(node, config, intermediateFormat);
    if (codec !== undefined) {
      node.codec = codec;
    }
  }
  if (node.kind === "object") {
    if (config.naming.properties === "camelCase") {
      renameProperties(node, ownerName);
    }
  }
  for (const child of childNodes(node)) {
    planNode(child, ownerName, config, intermediateFormat);
  }
}

function renameProperties(node: Extract<TypeNode, { kind: "object" }>, ownerName: string): void {
  const wireNameByAppName = new Map<string, string>();
  for (const property of node.properties) {
    property.appName = camelProperty(property.name);
    const clashingWireName = wireNameByAppName.get(property.appName);
    if (clashingWireName !== undefined) {
      const [firstName, secondName] = [clashingWireName, property.name].sort();
      const owner = ownerName === "" ? "an inline schema" : ownerName;
      throw new Error(`naming: properties "${firstName}" and "${secondName}" of ${owner} both become "${property.appName}"; set naming.properties to "preserve" or rename one`);
    }
    wireNameByAppName.set(property.appName, property.name);
  }
}

function codecFor(node: TypeNode, config: Config, intermediateFormat: IntermediateFormat): Codec | undefined {
  if (node.kind !== "string" && node.kind !== "number") {
    return undefined;
  }
  const format = node.constraints.format;
  if (format === undefined) {
    return undefined;
  }
  const hookKey = `format:${format}`;
  if (hookKey in intermediateFormat.hooks) {
    return { kind: "hook", hook: hookKey };
  }
  if (node.kind === "string" && format === "date-time" && config.formats["date-time"] === "Date") {
    return { kind: "date-time" };
  }
  if (node.kind === "string" && format === "date" && config.formats.date === "Date") {
    return { kind: "date" };
  }
  if (node.kind === "number" && node.integer && format === "int64" && config.formats.int64 === "bigint") {
    return { kind: "bigint" };
  }
  return undefined;
}

/** The direct children of a node; references are not followed. */
function childNodes(node: TypeNode): TypeNode[] {
  switch (node.kind) {
    case "array":
      return [node.items];
    case "tuple": {
      const children = [...node.prefix];
      if (node.rest) {
        children.push(node.rest);
      }
      return children;
    }
    case "union":
    case "intersection":
      return node.members;
    case "object": {
      const children = node.properties.map((property) => property.type);
      if (typeof node.additional === "object") {
        children.push(node.additional);
      }
      return children;
    }
    default:
      return [];
  }
}

/** Every node in the tree below and including `node`; references are not followed. */
function allNodes(node: TypeNode): TypeNode[] {
  const nodes = [node];
  for (const child of childNodes(node)) {
    nodes.push(...allNodes(child));
  }
  return nodes;
}

function referencedNames(node: TypeNode): string[] {
  const names: string[] = [];
  for (const descendant of allNodes(node)) {
    if (descendant.kind === "ref") {
      names.push(descendant.name);
    }
  }
  return names;
}

function hasOwnTransform(declaration: Declaration): boolean {
  for (const node of allNodes(declaration.type)) {
    if (node.codec !== undefined) {
      return true;
    }
    if (node.kind === "object" && node.properties.some((property) => property.appName !== property.name)) {
      return true;
    }
  }
  return false;
}

/** A declaration is transformed WHEN it has a codec or rename itself, or reaches a transformed one (fixpoint, so cycles terminate). */
function markTransformed(declarations: Declaration[], declarationsByName: Map<string, Declaration>): void {
  for (const declaration of declarations) {
    if (declaration.kind !== "parameter" && hasOwnTransform(declaration)) {
      declaration.transformed = true;
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (declaration.transformed || declaration.kind === "parameter") {
        continue;
      }
      const reachesTransformed = referencedNames(declaration.type).some((name) => declarationsByName.get(name)?.transformed === true);
      if (reachesTransformed) {
        declaration.transformed = true;
        changed = true;
      }
    }
  }
}

/** A declaration is runtime WHEN a request or response body reaches it. */
function markRuntime(bodyTypes: TypeNode[], declarationsByName: Map<string, Declaration>): void {
  const pending = bodyTypes.flatMap(referencedNames);
  while (pending.length > 0) {
    const declaration = declarationsByName.get(pending.pop()!);
    if (declaration === undefined || declaration.runtime) {
      continue;
    }
    declaration.runtime = true;
    pending.push(...referencedNames(declaration.type));
  }
}
