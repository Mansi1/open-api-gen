// Emits wire and App types, one file per declaration in dist3's layout. Enums are `as const` arrays with a derived
// type, so the allowed values exist at runtime too, which a TypeScript `enum` or a bare union would not give.
// VERIFIED: test/interfaces.test.ts compares the output with dist3's interfaces via the TypeScript AST.
import type { Constraints, Declaration, IntermediateFormat, Property, TypeNode } from "../intermediate-format/types.ts";
import { HEADER, hookImportPath, importPath, type Files } from "./layout.ts";
import { docComment, identifier, literal, propertyKey, quote } from "./names.ts";

/** Wire types are exactly what travels over HTTP; App types are what a client with `transform: true` hands out. */
export type Shape = "wire" | "app";

const INDENT = "    ";

/** The file a declaration is written to, in the given shape. App files exist only for transformed declarations. */
export function declarationPath(declaration: Declaration, shape: Shape): string {
  if (shape === "app" && declaration.transformed) {
    return `interface/app/${declaration.name}.ts`;
  }
  return `interface/${declaration.kind}/${declaration.name}.ts`;
}

/** Writes one file per declaration (dist3 layout), plus `interface/app/<Name>.ts` for every transformed one. */
export function emitInterfaces(intermediateFormat: IntermediateFormat): Files {
  const files: Files = new Map();
  const declarationsByName = new Map(intermediateFormat.declarations.map((declaration) => [declaration.name, declaration]));
  for (const declaration of intermediateFormat.declarations) {
    const wirePath = declarationPath(declaration, "wire");
    files.set(wirePath, renderDeclarationFile(declaration, "wire", wirePath, intermediateFormat, declarationsByName));
    if (declaration.transformed) {
      const appPath = declarationPath(declaration, "app");
      files.set(appPath, renderDeclarationFile(declaration, "app", appPath, intermediateFormat, declarationsByName));
    }
  }
  return files;
}

/** The `import type` statements one generated file needs; several renderers may share one collector. */
export class TypeImports {
  private readonly specifiersByModule = new Map<string, Set<string>>();

  /** `specifier` is a name, or `Name as Alias`. */
  add(modulePath: string, specifier: string): void {
    let specifiers = this.specifiersByModule.get(modulePath);
    if (specifiers === undefined) {
      specifiers = new Set();
      this.specifiersByModule.set(modulePath, specifiers);
    }
    specifiers.add(specifier);
  }

  /** Sorted for stable output. */
  lines(): string {
    const lines: string[] = [];
    for (const modulePath of [...this.specifiersByModule.keys()].sort()) {
      const specifiers = [...this.specifiersByModule.get(modulePath)!].sort();
      lines.push(`import type { ${specifiers.join(", ")} } from ${quote(modulePath)};`);
    }
    if (lines.length === 0) {
      return "";
    }
    return `${lines.join("\n")}\n`;
  }
}

/** The local name of a transformed declaration's App type in files that also use its wire type. */
export function appAlias(name: string): string {
  return `${name}$App`;
}

/** Renders type expressions for one file and records the imports they need. */
export class TypeRenderer {
  constructor(
    private readonly filePath: string,
    private readonly shape: Shape,
    private readonly intermediateFormat: IntermediateFormat,
    private readonly declarationsByName: Map<string, Declaration>,
    private readonly imports: TypeImports = new TypeImports(),
    /** True in files that use wire and App types side by side (services): App types are imported as `Name$App`. */
    private readonly aliasAppTypes = false,
    /** True for parameter interfaces: int64 values may be passed as bigint, which createFetchSend sends exactly. */
    private readonly int64AcceptsBigint = false,
  ) {}

  importLines(): string {
    return this.imports.lines();
  }

  private addImport(modulePath: string, name: string): void {
    this.imports.add(modulePath, name);
  }

  /** The TypeScript type expression for a node. */
  render(node: TypeNode): string {
    if (this.shape === "app" && node.codec !== undefined) {
      return this.renderCodecType(node.codec);
    }
    switch (node.kind) {
      case "ref":
        return this.renderReference(node.name);
      case "string":
        return "string";
      case "number":
        if (this.int64AcceptsBigint && node.integer && node.constraints.format === "int64") {
          return "number | bigint";
        }
        return "number";
      case "boolean":
        return "boolean";
      case "null":
        return "null";
      case "binary":
        return "Blob";
      case "unknown":
        return "unknown";
      case "never":
        return "never";
      case "literal":
        return literal(node.value);
      case "enum":
        return uniqueJoin(node.values.map(literal), " | ");
      case "array":
        return `Array<${this.render(node.items)}>`;
      case "tuple":
        return this.renderTuple(node);
      case "object":
        return this.renderInlineObject(node);
      case "union":
        return uniqueJoin(node.members.map((member) => this.renderMember(member)), " | ");
      case "intersection":
        return uniqueJoin(node.members.map((member) => this.renderMember(member)), " & ");
    }
  }

  private renderCodecType(codec: NonNullable<TypeNode["codec"]>): string {
    if (codec.kind === "date-time" || codec.kind === "date") {
      return "Date";
    }
    if (codec.kind === "bigint") {
      return "bigint";
    }
    const hook = this.intermediateFormat.hooks[codec.hook];
    if (hook === undefined) {
      throw new Error(`intermediate format contract: codec references unknown hook "${codec.hook}"`);
    }
    this.addImport(hookImportPath(this.filePath, hook.import), identifier(hook.type));
    return hook.type;
  }

  private renderReference(name: string): string {
    const target = this.declarationsByName.get(name);
    if (target === undefined) {
      throw new Error(`intermediate format contract: reference to unknown declaration "${name}"`);
    }
    const targetPath = declarationPath(target, this.shape);
    if (targetPath === this.filePath) {
      return name;
    }
    if (this.aliasAppTypes && this.shape === "app" && target.transformed) {
      const alias = appAlias(identifier(name));
      this.addImport(importPath(this.filePath, targetPath), `${name} as ${alias}`);
      return alias;
    }
    this.addImport(importPath(this.filePath, targetPath), identifier(name));
    return name;
  }

  /** Union and intersection members that are themselves compound need parentheses. */
  private renderMember(member: TypeNode): string {
    const rendered = this.render(member);
    const isCompound = (member.kind === "union" || member.kind === "intersection" || member.kind === "enum") && rendered.includes(" ");
    if (isCompound && member.codec === undefined) {
      return `(${rendered})`;
    }
    return rendered;
  }

  private renderTuple(node: Extract<TypeNode, { kind: "tuple" }>): string {
    const elements = node.prefix.map((element) => this.render(element));
    if (node.rest === null) {
      elements.push("...Array<unknown>");
    } else if (node.rest !== false) {
      elements.push(`...Array<${this.render(node.rest)}>`);
    }
    return `[${elements.join(", ")}]`;
  }

  private renderInlineObject(node: Extract<TypeNode, { kind: "object" }>): string {
    if (node.properties.length === 0) {
      return this.renderMapType(node.additional);
    }
    const members = node.properties.map((property) => `${propertyKey(this.propertyName(property))}${property.required ? "" : "?"}: ${this.render(property.type)}`);
    if (typeof node.additional === "object") {
      // An index signature must accept every declared property, so it can only be unknown here.
      members.push("[key: string]: unknown");
    }
    return `{ ${members.join("; ")} }`;
  }

  /** An object without declared properties: a map, a free-form object, or an object that must stay empty. */
  renderMapType(additional: TypeNode | boolean): string {
    if (additional === false) {
      return "Record<string, never>";
    }
    if (additional === true) {
      return "Record<string, unknown>";
    }
    return `Record<string, ${this.render(additional)}>`;
  }

  propertyName(property: Property): string {
    if (this.shape === "app") {
      return property.appName;
    }
    return property.name;
  }
}

function renderDeclarationFile(declaration: Declaration, shape: Shape, filePath: string, intermediateFormat: IntermediateFormat, declarationsByName: Map<string, Declaration>): string {
  const renderer = new TypeRenderer(filePath, shape, intermediateFormat, declarationsByName, undefined, false, declaration.kind === "parameter");
  const name = identifier(declaration.name);
  const body = renderDeclarationBody(declaration, name, shape, renderer);
  const imports = renderer.importLines();
  const commentLines: string[] = [];
  if (shape === "app") {
    commentLines.push(`App shape of ${name}: what a client created with \`transform: true\` returns and accepts.`);
    commentLines.push("");
  }
  if (declaration.description !== undefined) {
    commentLines.push(declaration.description, "");
  }
  if (declaration.deprecated === true) {
    commentLines.push("@deprecated", "");
  }
  commentLines.push("Open-api schema");
  commentLines.push(...JSON.stringify(declaration.source ?? {}, null, 2).split("\n"));

  const parts = [HEADER];
  if (imports !== "") {
    parts.push(imports);
  }
  parts.push(`\n${docComment(commentLines)}${body}`);
  return parts.join("");
}

function renderDeclarationBody(declaration: Declaration, name: string, shape: Shape, renderer: TypeRenderer): string {
  const type = declaration.type;
  if (shape === "app" && type.codec !== undefined) {
    return `export type ${name} = ${renderer.render(type)};\n`;
  }
  if (type.kind === "enum") {
    return renderEnum(name, type.values.map(literal));
  }
  if (type.kind === "object" && type.properties.length > 0) {
    return renderInterface(name, type, renderer);
  }
  if (type.kind === "object") {
    return `export type ${name} = ${renderer.renderMapType(type.additional)};\n`;
  }
  return `export type ${name} = ${renderer.render(type)};\n`;
}

/**
 * The values array is the single source of truth (`as const`) and the type is derived from it, so the list
 * and the union can never drift apart.
 */
function renderEnum(name: string, values: string[]): string {
  const uniqueValues = [...new Set(values)];
  const list = uniqueValues.map((value) => `${INDENT}${value},`).join("\n");
  return `export const ${name}Values = [\n${list}\n] as const;\n\nexport type ${name} = typeof ${name}Values[number];\n`;
}

function renderInterface(name: string, type: Extract<TypeNode, { kind: "object" }>, renderer: TypeRenderer): string {
  const members: string[] = [];
  for (const property of type.properties) {
    const comment = docComment(propertyCommentLines(property), INDENT);
    const optionalMark = property.required ? "" : "?";
    members.push(`${comment}${INDENT}${propertyKey(renderer.propertyName(property))}${optionalMark}: ${renderer.render(property.type)};\n`);
  }
  if (typeof type.additional === "object") {
    const comment = docComment(["Additional properties allowed by the schema."], INDENT);
    members.push(`${comment}${INDENT}[key: string]: unknown;\n`);
  }
  return `export interface ${name} {\n\n${members.join("\n")}\n}\n`;
}

/** dist3 property comments: description, then `open-api format:` and the `open-api validation:` constraint list. */
function propertyCommentLines(property: Property): string[] {
  const lines: string[] = [];
  if (property.description !== undefined) {
    lines.push(property.description);
  }
  if (property.deprecated === true) {
    lines.push("@deprecated");
  }
  const constraints = constraintsOf(property.type);
  if (constraints.format !== undefined) {
    lines.push(`open-api format: ${constraints.format}`);
  }
  const validation = Object.entries(constraints).filter(([keyword]) => keyword !== "format");
  if (validation.length > 0) {
    lines.push("open-api validation:");
    for (const [keyword, value] of validation) {
      lines.push(`  - ${keyword}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
    }
  }
  return lines;
}

function constraintsOf(node: TypeNode): Constraints {
  if (node.kind === "string" || node.kind === "number" || node.kind === "array" || node.kind === "tuple" || node.kind === "object") {
    return node.constraints;
  }
  return {};
}

function uniqueJoin(parts: string[], separator: string): string {
  return [...new Set(parts)].join(separator);
}
