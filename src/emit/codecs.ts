// Emits `<Name>.codec.ts` transformers as small expressions over runtime/transform.ts, instead of generating a
// conversion routine per schema, so conversion semantics live in one hand-written, directly tested runtime.
// VERIFIED: test/codecs.test.ts round-trips emitted codecs (decode then encode) on fixture samples.
import type { Codec, Declaration, IntermediateFormat, TypeNode } from "../intermediate-format/types.ts";
import { HEADER, hookImportPath, importPath, type Files } from "./layout.ts";
import { identifier, propertyKey, quote } from "./names.ts";
import { ValidatorRenderer } from "./validators.ts";

const RUNTIME_MODULE = "runtime/transform.ts";

/** Where the transformer of a declaration lives: next to its wire type and validator. */
export function codecPath(declaration: Declaration): string {
  return `interface/${declaration.kind}/${declaration.name}.codec.ts`;
}

export function transformerName(declaration: Declaration): string {
  return `transform${identifier(declaration.name)}`;
}

/** One `<Name>.codec.ts` per transformed declaration that a request or response reaches. */
export function emitCodecs(intermediateFormat: IntermediateFormat): Files {
  const files: Files = new Map();
  const declarationsByName = new Map(intermediateFormat.declarations.map((declaration) => [declaration.name, declaration]));
  for (const declaration of intermediateFormat.declarations) {
    if (!declaration.runtime || !declaration.transformed) {
      continue;
    }
    const path = codecPath(declaration);
    const renderer = new CodecRenderer(path, intermediateFormat, declarationsByName);
    const expression = renderer.render(declaration.type);
    const comment = `/** Converts ${declaration.name} between its wire shape and its App shape. */`;
    files.set(path, `${HEADER}${renderer.importLines()}\n${comment}\nexport const ${transformerName(declaration)}: Transformer = ${expression};\n`);
  }
  return files;
}

/** Renders transformer expressions for one file and collects the imports they need. */
export class CodecRenderer {
  private readonly runtimeNames = new Set<string>();
  private readonly codecImports = new Map<string, string>();
  private readonly hookImports = new Map<string, Set<string>>();
  private readonly validators: ValidatorRenderer;
  /** True WHEN the validators belong to another renderer of the same file, which then also writes their imports. */
  private readonly sharesValidators: boolean;

  constructor(
    private readonly filePath: string,
    private readonly intermediateFormat: IntermediateFormat,
    private readonly declarationsByName: Map<string, Declaration>,
    /** When set, transform functions are used as `<qualifier>.name` through a namespace import (service files). */
    private readonly qualifier?: string,
    /** A file that renders validators itself (services) passes its renderer, so each name is imported once. */
    sharedValidators?: ValidatorRenderer,
  ) {
    // Union routing needs validators; they are always qualified, because both runtimes export `array` and `lazy`.
    this.validators = sharedValidators ?? new ValidatorRenderer(filePath, declarationsByName, "validation");
    this.sharesValidators = sharedValidators !== undefined;
  }

  /** `includeTransformerType`: false for files that only use transformers inside expressions (service files). */
  importLines(includeTransformerType = true): string {
    const runtimePath = importPath(this.filePath, RUNTIME_MODULE);
    const runtimeValues = [...this.runtimeNames].sort();
    const lines: string[] = [];
    if (this.qualifier !== undefined) {
      if (runtimeValues.length > 0) {
        lines.push(`import * as ${this.qualifier} from ${quote(runtimePath)};`);
      }
    } else {
      const imported = includeTransformerType ? [...runtimeValues, "type Transformer"] : runtimeValues;
      if (imported.length > 0) {
        lines.push(`import { ${imported.join(", ")} } from ${quote(runtimePath)};`);
      }
    }
    const validatorLines = this.sharesValidators ? "" : this.validators.importLines(false);
    if (validatorLines !== "") {
      lines.push(validatorLines.trimEnd());
    }
    for (const [modulePath, name] of [...this.codecImports].sort()) {
      lines.push(`import { ${name} } from ${quote(modulePath)};`);
    }
    for (const modulePath of [...this.hookImports.keys()].sort()) {
      lines.push(`import { ${[...this.hookImports.get(modulePath)!].sort().join(", ")} } from ${quote(modulePath)};`);
    }
    if (lines.length === 0) {
      return "";
    }
    return `${lines.join("\n")}\n`;
  }

  private use(runtimeName: string): string {
    this.runtimeNames.add(runtimeName);
    if (this.qualifier !== undefined) {
      return `${this.qualifier}.${runtimeName}`;
    }
    return runtimeName;
  }

  /** True WHEN converting this node changes anything: a codec, a rename, or a transformed reference below it. */
  needsTransform(node: TypeNode): boolean {
    if (node.codec !== undefined) {
      return true;
    }
    switch (node.kind) {
      case "ref":
        return this.declarationsByName.get(node.name)?.transformed === true;
      case "array":
        return this.needsTransform(node.items);
      case "tuple":
        return node.prefix.some((element) => this.needsTransform(element)) || (typeof node.rest === "object" && node.rest !== null && this.needsTransform(node.rest));
      case "object":
        return node.properties.some((property) => property.appName !== property.name || this.needsTransform(property.type)) || (typeof node.additional === "object" && this.needsTransform(node.additional));
      case "union":
      case "intersection":
        return node.members.some((member) => this.needsTransform(member));
      default:
        return false;
    }
  }

  render(node: TypeNode): string {
    if (!this.needsTransform(node)) {
      return this.use("identity");
    }
    if (node.codec !== undefined) {
      return this.renderCodec(node.codec);
    }
    switch (node.kind) {
      case "ref":
        return this.renderReference(node.name);
      case "array":
        return `${this.use("array")}(${this.render(node.items)})`;
      case "tuple": {
        const prefix = node.prefix.map((element) => this.render(element)).join(", ");
        const rest = typeof node.rest === "object" && node.rest !== null ? this.render(node.rest) : this.use("identity");
        return `${this.use("tuple")}([${prefix}], ${rest})`;
      }
      case "object":
        return this.renderObject(node);
      case "union":
        return this.renderUnion(node);
      case "intersection": {
        const members = node.members.filter((member) => this.needsTransform(member)).map((member) => this.render(member));
        return `${this.use("allOf")}([${members.join(", ")}])`;
      }
      default:
        return this.use("identity");
    }
  }

  private renderCodec(codec: Codec): string {
    if (codec.kind === "date-time") {
      return this.use("dateTime");
    }
    if (codec.kind === "date") {
      return this.use("date");
    }
    if (codec.kind === "bigint") {
      return this.use("bigint");
    }
    const hookDefinition = this.intermediateFormat.hooks[codec.hook];
    if (hookDefinition === undefined) {
      throw new Error(`intermediate format contract: codec references unknown hook "${codec.hook}"`);
    }
    const modulePath = hookImportPath(this.filePath, hookDefinition.import);
    let names = this.hookImports.get(modulePath);
    if (names === undefined) {
      names = new Set();
      this.hookImports.set(modulePath, names);
    }
    names.add(identifier(hookDefinition.decode));
    names.add(identifier(hookDefinition.encode));
    return `${this.use("hook")}(${hookDefinition.decode}, ${hookDefinition.encode})`;
  }

  /** Transformed references are lazy, like validators, so recursion and import cycles stay safe. */
  private renderReference(name: string): string {
    const target = this.declarationsByName.get(name);
    if (target === undefined) {
      throw new Error(`intermediate format contract: reference to unknown declaration "${name}"`);
    }
    if (!target.transformed) {
      return this.use("identity");
    }
    const targetPath = codecPath(target);
    if (targetPath !== this.filePath) {
      this.codecImports.set(importPath(this.filePath, targetPath), transformerName(target));
    }
    return `${this.use("lazy")}(() => ${transformerName(target)})`;
  }

  private renderObject(node: Extract<TypeNode, { kind: "object" }>): string {
    const entries: string[] = [];
    for (const property of node.properties) {
      if (property.appName === property.name && !this.needsTransform(property.type)) {
        continue;
      }
      entries.push(`${propertyKey(property.name)}: { appName: ${quote(property.appName)}, transformer: ${this.render(property.type)} }`);
    }
    const properties = `{ ${entries.join(", ")} }`;
    if (typeof node.additional === "object" && this.needsTransform(node.additional)) {
      return `${this.use("object")}(${properties}, ${this.render(node.additional)})`;
    }
    return `${this.use("object")}(${properties})`;
  }

  private renderUnion(node: Extract<TypeNode, { kind: "union" }>): string {
    const members = node.members.map((member) => `{ validator: ${this.validators.render(member)}, transformer: ${this.render(member)} }`);
    if (node.discriminator === undefined) {
      return `${this.use("union")}([${members.join(", ")}])`;
    }
    const mapping = Object.entries(node.discriminator.mapping).map(([value, name]) => `${quote(value)}: ${this.renderReference(name)}`);
    return `${this.use("union")}([${members.join(", ")}], { property: ${quote(node.discriminator.property)}, mapping: { ${mapping.join(", ")} } })`;
  }
}
