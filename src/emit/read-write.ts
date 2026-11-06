// Request and response variants of declarations with required readOnly / writeOnly properties, emitted once per API
// into interface/read-write.ts. A request body need not carry a required readOnly property (the server sets it), a
// response need not carry a required writeOnly one (the server never returns it): OpenAPI 3.0 says so, and the
// validators apply the same rule. Variants are built on the declared types, e.g.
//   type Account$Request = Omit<Account, 'id' | 'members'> & { id?: Account['id']; members: Array<Member$Request> }
// Each declaration gets at most one variant per shape and direction, and nested references point at other variants
// by name, so the output grows linearly with the schema graph and recursive schemas need no special case. Inlining
// the variants into method signatures instead grew exponentially on the Stripe spec (shared schemas expanded per path).
// VERIFIED: test/services.test.ts type-checks the variants, nested and renamed, and make e2e generates Stripe and GitHub.
import type { Declaration, IntermediateFormat, Property, TypeNode } from "../intermediate-format/types.ts";
import { TypeImports, TypeRenderer } from "./interfaces.ts";
import { HEADER, importPath, type Files } from "./layout.ts";
import { identifier, propertyKey, quote } from "./names.ts";

export const READ_WRITE_PATH = "interface/read-write.ts";

/** Which way a body travels; decides whether readOnly or writeOnly properties are relaxed. */
export type Direction = "request" | "response";

type Variant = { isApp: boolean; direction: Direction };

export class ReadWriteVariants {
  private readonly imports = new TypeImports();
  private readonly wireTypes: TypeRenderer;
  private readonly appTypes: TypeRenderer;
  /** Per variant key, the declarations that need a variant (computed once, on first use). */
  private readonly relaxedByVariant = new Map<string, Set<string>>();
  private readonly definitions = new Map<string, string>();
  private readonly pending: { name: string; variant: Variant }[] = [];

  constructor(
    intermediateFormat: IntermediateFormat,
    private readonly declarationsByName: Map<string, Declaration>,
  ) {
    this.wireTypes = new TypeRenderer(READ_WRITE_PATH, "wire", intermediateFormat, declarationsByName, this.imports);
    this.appTypes = new TypeRenderer(READ_WRITE_PATH, "app", intermediateFormat, declarationsByName, this.imports, true);
  }

  /**
   * The variant name for a body type when it needs one: a reference, or an array of references (Stage 1 extracts
   * inline bodies into declarations, so bodies are references). Undefined WHEN the declared type already fits.
   */
  bodyType(node: TypeNode, isApp: boolean, direction: Direction): { name: string } | { arrayOf: string } | undefined {
    const variant = { isApp, direction };
    if (node.kind === "ref" && this.relaxed(variant).has(node.name)) {
      return { name: this.variantName(node.name, variant) };
    }
    if (node.kind === "array" && node.items.kind === "ref" && this.relaxed(variant).has(node.items.name)) {
      return { arrayOf: this.variantName(node.items.name, variant) };
    }
    return undefined;
  }

  /** interface/read-write.ts, or nothing WHEN no body needed a variant. */
  files(): Files {
    while (this.pending.length > 0) {
      const { name, variant } = this.pending.pop()!;
      const declaration = this.declarationsByName.get(name)!;
      const renderer = variant.isApp ? this.appTypes : this.wireTypes;
      const base = renderer.render({ kind: "ref", name });
      const definition =
        declaration.type.kind === "object"
          ? this.objectExpression(declaration.type.properties, base, variant)
          : (this.expression(declaration.type, variant) ?? base);
      this.definitions.set(this.variantName(name, variant), definition);
    }
    if (this.definitions.size === 0) {
      return new Map();
    }
    const aliases = [...this.definitions.keys()].sort().map((aliasName) => `export type ${aliasName} = ${this.definitions.get(aliasName)};\n`);
    return new Map([[READ_WRITE_PATH, `${HEADER}${this.imports.lines()}\n${aliases.join("")}`]]);
  }

  /** `Account$Request`, `Account$App$Response`; `$` never occurs in declaration names, so these cannot clash. */
  private variantName(name: string, variant: Variant): string {
    const aliasName = `${identifier(name)}${variant.isApp ? "$App" : ""}$${variant.direction === "request" ? "Request" : "Response"}`;
    if (!this.definitions.has(aliasName)) {
      // Reserve the name now, define it in files(): a recursive schema refers to its own variant while being defined.
      this.definitions.set(aliasName, "");
      this.pending.push({ name, variant });
    }
    return aliasName;
  }

  private relaxedKey(property: Property, variant: Variant): boolean {
    const sentByOtherSide = variant.direction === "request" ? property.readOnly === true : property.writeOnly === true;
    return property.required && sentByOtherSide;
  }

  /** The declarations that reach a relaxed property: those holding one, then everything referencing them. */
  private relaxed(variant: Variant): Set<string> {
    const key = `${variant.isApp}:${variant.direction}`;
    const cached = this.relaxedByVariant.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const referrersByName = new Map<string, string[]>();
    const relaxed = new Set<string>();
    const pending: string[] = [];
    for (const declaration of this.declarationsByName.values()) {
      const { holdsRelaxed, references } = this.scan(declaration.type, variant);
      for (const reference of references) {
        let referrers = referrersByName.get(reference);
        if (referrers === undefined) {
          referrers = [];
          referrersByName.set(reference, referrers);
        }
        referrers.push(declaration.name);
      }
      if (holdsRelaxed) {
        relaxed.add(declaration.name);
        pending.push(declaration.name);
      }
    }
    while (pending.length > 0) {
      for (const referrer of referrersByName.get(pending.pop()!) ?? []) {
        if (!relaxed.has(referrer)) {
          relaxed.add(referrer);
          pending.push(referrer);
        }
      }
    }
    this.relaxedByVariant.set(key, relaxed);
    return relaxed;
  }

  /** The parts of a type this module rewrites: objects, arrays, unions, intersections; App codecs stay as declared. */
  private scan(node: TypeNode, variant: Variant): { holdsRelaxed: boolean; references: string[] } {
    const result = { holdsRelaxed: false, references: [] as string[] };
    const visit = (current: TypeNode): void => {
      if (variant.isApp && current.codec !== undefined) {
        return;
      }
      if (current.kind === "ref") {
        result.references.push(current.name);
      } else if (current.kind === "object") {
        for (const property of current.properties) {
          if (this.relaxedKey(property, variant)) {
            result.holdsRelaxed = true;
          }
          visit(property.type);
        }
      } else if (current.kind === "array") {
        visit(current.items);
      } else if (current.kind === "union" || current.kind === "intersection") {
        current.members.forEach(visit);
      }
    };
    visit(node);
    return result;
  }

  private needsVariant(node: TypeNode, variant: Variant): boolean {
    const { holdsRelaxed, references } = this.scan(node, variant);
    return holdsRelaxed || references.some((reference) => this.relaxed(variant).has(reference));
  }

  /** The relaxed form of a type inside interface/read-write.ts; undefined WHEN it needs none. */
  private expression(node: TypeNode, variant: Variant): string | undefined {
    if (!this.needsVariant(node, variant)) {
      return undefined;
    }
    const renderer = variant.isApp ? this.appTypes : this.wireTypes;
    switch (node.kind) {
      case "ref":
        return this.variantName(node.name, variant);
      case "object":
        return this.objectExpression(node.properties, renderer.render(node), variant);
      case "array":
        return `Array<${this.expression(node.items, variant)}>`;
      case "union":
      case "intersection": {
        const members = node.members.map((member) => `(${this.expression(member, variant) ?? renderer.render(member)})`);
        return members.join(node.kind === "union" ? " | " : " & ");
      }
      default:
        return undefined;
    }
  }

  private objectExpression(properties: Property[], base: string, variant: Variant): string {
    const members: string[] = [];
    const replacedKeys: string[] = [];
    for (const property of properties) {
      const key = variant.isApp ? property.appName : property.name;
      if (this.relaxedKey(property, variant)) {
        members.push(`${propertyKey(key)}?: ${base}[${quote(key)}]`);
        replacedKeys.push(key);
        continue;
      }
      const nested = this.expression(property.type, variant);
      if (nested !== undefined) {
        members.push(`${propertyKey(key)}${property.required ? "" : "?"}: ${nested}`);
        replacedKeys.push(key);
      }
    }
    if (replacedKeys.length === 0) {
      return base;
    }
    return `Omit<${base}, ${replacedKeys.map((key) => quote(key)).join(" | ")}> & { ${members.join("; ")} }`;
  }
}

/** The import line a service file needs for the variant names it used. */
export function readWriteImport(fromFile: string, names: Set<string>): string {
  if (names.size === 0) {
    return "";
  }
  return `import type { ${[...names].sort().join(", ")} } from ${quote(importPath(fromFile, READ_WRITE_PATH))};`;
}
