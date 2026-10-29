// Emits response validators as expressions over runtime/validation.ts. test/validators.test.ts checks their
// verdicts against @hyperjump/json-schema, so one runtime carries the JSON Schema semantics for every schema.
// VERIFIED: test/validators.test.ts compares verdicts with @hyperjump/json-schema as an oracle.
import type { Constraints, Declaration, IntermediateFormat, TypeNode } from "../intermediate-format/types.ts";
import { HEADER, importPath, type Files } from "./layout.ts";
import { identifier, literal, propertyKey, quote } from "./names.ts";

const RUNTIME_MODULE = "runtime/validation.ts";

/** Where the validator of a declaration lives: next to its wire type. */
export function validatorPath(declaration: Declaration): string {
  return `interface/${declaration.kind}/${declaration.name}.validate.ts`;
}

export function validatorName(declaration: Declaration): string {
  return `validate${identifier(declaration.name)}`;
}

/** One `<Name>.validate.ts` per declaration that a request or response reaches; they check wire values. */
export function emitValidators(intermediateFormat: IntermediateFormat): Files {
  const files: Files = new Map();
  const declarationsByName = new Map(intermediateFormat.declarations.map((declaration) => [declaration.name, declaration]));
  for (const declaration of intermediateFormat.declarations) {
    if (!declaration.runtime) {
      continue;
    }
    const path = validatorPath(declaration);
    const renderer = new ValidatorRenderer(path, declarationsByName);
    const expression = renderer.render(declaration.type);
    const content = `${HEADER}${renderer.importLines()}\n/** Checks a wire value against the ${declaration.name} schema. */\nexport const ${validatorName(declaration)}: Validator = ${expression};\n`;
    files.set(path, content);
  }
  return files;
}

/** Renders validator expressions for one file and collects the imports they need. */
export class ValidatorRenderer {
  private readonly runtimeNames = new Set<string>(["Validator"]);
  private readonly validatorImports = new Map<string, string>();

  constructor(
    private readonly filePath: string,
    private readonly declarationsByName: Map<string, Declaration>,
    /** When set, runtime functions are used as `<qualifier>.name` through a namespace import, so files that also
     * import runtime/transform.ts (codecs, services) get no clashing names such as `array` or `lazy`. */
    private readonly qualifier?: string,
  ) {}

  /** `includeValidatorType`: false for files that only use validators inside expressions (codec and service files). */
  importLines(includeValidatorType = true): string {
    const runtimePath = importPath(this.filePath, RUNTIME_MODULE);
    const runtimeValues = [...this.runtimeNames].filter((name) => name !== "Validator").sort();
    const lines: string[] = [];
    if (this.qualifier !== undefined) {
      if (runtimeValues.length > 0) {
        lines.push(`import * as ${this.qualifier} from ${quote(runtimePath)};`);
      }
    } else {
      const imported = includeValidatorType ? [...runtimeValues, "type Validator"] : runtimeValues;
      if (imported.length > 0) {
        lines.push(`import { ${imported.join(", ")} } from ${quote(runtimePath)};`);
      }
    }
    for (const [modulePath, name] of [...this.validatorImports].sort()) {
      lines.push(`import { ${name} } from ${quote(modulePath)};`);
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

  render(node: TypeNode): string {
    switch (node.kind) {
      case "ref":
        return this.renderReference(node.name);
      case "string":
        return `${this.use("string")}(${renderConstraints(node.constraints)})`;
      case "number":
        return `${this.use("number")}(${node.integer}, ${renderConstraints(node.constraints)})`;
      case "boolean":
        return this.use("boolean");
      case "null":
        return this.use("nullValue");
      case "binary":
      case "unknown":
        return this.use("anything");
      case "never":
        return this.use("nothing");
      case "literal":
        return `${this.use("literal")}(${literal(node.value)})`;
      case "enum":
        return `${this.use("oneOfValues")}([${node.values.map(literal).join(", ")}])`;
      case "array":
        return `${this.use("array")}(${this.render(node.items)}, ${renderConstraints(node.constraints)})`;
      case "tuple":
        return this.renderTuple(node);
      case "object":
        return this.renderObject(node);
      case "union":
        return this.renderUnion(node);
      case "intersection":
        return `${this.use("allOf")}([${node.members.map((member) => this.render(member)).join(", ")}])`;
    }
  }

  /** References are always lazy: recursion, and import cycles between validator modules, stay safe. */
  private renderReference(name: string): string {
    const target = this.declarationsByName.get(name);
    if (target === undefined) {
      throw new Error(`intermediate format contract: reference to unknown declaration "${name}"`);
    }
    const targetPath = validatorPath(target);
    if (targetPath !== this.filePath) {
      this.validatorImports.set(importPath(this.filePath, targetPath), validatorName(target));
    }
    return `${this.use("lazy")}(() => ${validatorName(target)})`;
  }

  private renderTuple(node: Extract<TypeNode, { kind: "tuple" }>): string {
    const prefix = node.prefix.map((element) => this.render(element)).join(", ");
    let rest: string;
    if (node.rest === false) {
      rest = "false";
    } else if (node.rest === null) {
      rest = "null";
    } else {
      rest = this.render(node.rest);
    }
    return `${this.use("tuple")}([${prefix}], ${rest}, ${renderConstraints(node.constraints)})`;
  }

  private renderObject(node: Extract<TypeNode, { kind: "object" }>): string {
    const rules = node.properties.map((property) => `${propertyKey(property.name)}: { required: ${property.required}, validator: ${this.render(property.type)} }`);
    let additional: string;
    if (typeof node.additional === "boolean") {
      additional = String(node.additional);
    } else {
      additional = this.render(node.additional);
    }
    return `${this.use("object")}({ ${rules.join(", ")} }, ${additional}, ${renderConstraints(node.constraints)})`;
  }

  private renderUnion(node: Extract<TypeNode, { kind: "union" }>): string {
    const members = node.members.map((member) => this.render(member)).join(", ");
    if (node.mode === "anyOf") {
      return `${this.use("anyOf")}([${members}])`;
    }
    if (node.discriminator === undefined) {
      return `${this.use("oneOf")}([${members}])`;
    }
    const mapping = Object.entries(node.discriminator.mapping).map(([value, name]) => `${quote(value)}: ${this.renderReference(name)}`);
    return `${this.use("oneOf")}([${members}], { property: ${quote(node.discriminator.property)}, mapping: { ${mapping.join(", ")} } })`;
  }
}

/** Constraint values come from the spec, so they are rendered with the escaping helpers, never pasted. */
function renderConstraints(constraints: Constraints): string {
  const entries: string[] = [];
  for (const [keyword, value] of Object.entries(constraints)) {
    if (typeof value === "string") {
      entries.push(`${keyword}: ${quote(value)}`);
    } else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
      entries.push(`${keyword}: ${String(value)}`);
    }
    // Anything else is a malformed spec value; dropping it only makes validation more permissive.
  }
  if (entries.length === 0) {
    return "{}";
  }
  return `{ ${entries.join(", ")} }`;
}
