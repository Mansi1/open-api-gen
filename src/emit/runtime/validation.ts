// Copied verbatim into every generated client as runtime/validation.ts. It must not import anything,
// and it must run unchanged in browsers, Node.js and Bun.
// VERIFIED: test/validators.test.ts checks these validators against @hyperjump/json-schema.

/** One way a value differs from its schema; `path` is a JSON Pointer into the checked value. */
export type Issue = { path: string; message: string };

/** Appends every issue of `value` to `issues`; `path` locates `value` inside the checked document. */
/** Which way a value travels: `required` skips readOnly properties in requests and writeOnly properties in responses. */
export type Direction = "request" | "response";

export type Validator = (value: unknown, path: string, issues: Issue[], direction?: Direction) => void;

export type Constraints = {
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minProperties?: number;
  maxProperties?: number;
};

/**
 * `readOnly`/`writeOnly` mark properties only one side sends. OpenAPI 3.0 limits `required` on them to responses and
 * requests respectively; 3.1 and 3.2 make them annotations a server may ignore, so the client applies the 3.0 rule to all.
 */
export type PropertyRule = { required: boolean; validator: Validator; readOnly?: boolean; writeOnly?: boolean };

/** Runs a validator from the document root and returns every issue; an empty list means the value is valid. */
export function validate(validator: Validator, value: unknown, direction: Direction = "response"): Issue[] {
  const issues: Issue[] = [];
  validator(value, "", issues, direction);
  return issues;
}

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (unsafeIntegerDigits(value) !== undefined) {
    return "number";
  }
  return typeof value;
}

function childPath(path: string, key: string | number): string {
  const token = String(key).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${token}`;
}

/** runtime/json.ts parseJson's marker for an integer beyond 2^53; recognized by its registry symbol. */
const UNSAFE_INTEGER = Symbol.for("open-api-gen.unsafeInteger");

function unsafeIntegerDigits(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null && UNSAFE_INTEGER in value) {
    return (value as Record<symbol, string>)[UNSAFE_INTEGER];
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && unsafeIntegerDigits(value) === undefined;
}

// ---------------------------------------------------------------- scalars

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/** Date.parse rolls impossible days over (2024-02-30 → March 1); a real calendar date survives the round trip. */
function isCalendarDate(fullDate: string): boolean {
  const parsed = new Date(`${fullDate}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === fullDate;
}

/** Only the formats the client converts are checked; every other format is an annotation, as in JSON Schema. */
function checkFormat(text: string, format: string | undefined): string | undefined {
  if (format === "date-time" && (!DATE_TIME_PATTERN.test(text) || Number.isNaN(Date.parse(text)) || !isCalendarDate(text.slice(0, 10)))) {
    return "must be an RFC 3339 date-time";
  }
  if (format === "date" && (!DATE_PATTERN.test(text) || !isCalendarDate(text))) {
    return "must be an RFC 3339 full-date (YYYY-MM-DD)";
  }
  return undefined;
}

export function string(constraints: Constraints = {}): Validator {
  // Compiled once, when the generated module loads.
  const pattern = constraints.pattern === undefined ? undefined : new RegExp(constraints.pattern, "u");
  return (value, path, issues) => {
    if (typeof value !== "string") {
      issues.push({ path, message: `must be a string, got ${describe(value)}` });
      return;
    }
    // JSON Schema counts code points, not UTF-16 units.
    const length = [...value].length;
    if (constraints.minLength !== undefined && length < constraints.minLength) {
      issues.push({ path, message: `must have at least ${constraints.minLength} characters` });
    }
    if (constraints.maxLength !== undefined && length > constraints.maxLength) {
      issues.push({ path, message: `must have at most ${constraints.maxLength} characters` });
    }
    if (pattern !== undefined && !pattern.test(value)) {
      issues.push({ path, message: `must match pattern ${constraints.pattern}` });
    }
    const formatProblem = checkFormat(value, constraints.format);
    if (formatProblem !== undefined) {
      issues.push({ path, message: formatProblem });
    }
  };
}

export function number(integer: boolean, constraints: Constraints = {}): Validator {
  return (value, path, issues) => {
    // An integer beyond 2^53 arrives as runtime/json.ts's marker (lossless parse) or as a bigint (a custom send).
    const digits = unsafeIntegerDigits(value);
    const isBigInt = typeof value === "bigint" || digits !== undefined;
    if (typeof value !== "number" && !isBigInt) {
      issues.push({ path, message: `must be a number, got ${describe(value)}` });
      return;
    }
    const numeric = Number(digits ?? value);
    if (typeof value === "number" && !Number.isFinite(value)) {
      issues.push({ path, message: "must be a finite number" });
      return;
    }
    if (integer && !isBigInt && !Number.isInteger(numeric)) {
      issues.push({ path, message: "must be an integer" });
    }
    if (constraints.minimum !== undefined && numeric < constraints.minimum) {
      issues.push({ path, message: `must be >= ${constraints.minimum}` });
    }
    if (constraints.maximum !== undefined && numeric > constraints.maximum) {
      issues.push({ path, message: `must be <= ${constraints.maximum}` });
    }
    if (constraints.exclusiveMinimum !== undefined && numeric <= constraints.exclusiveMinimum) {
      issues.push({ path, message: `must be > ${constraints.exclusiveMinimum}` });
    }
    if (constraints.exclusiveMaximum !== undefined && numeric >= constraints.exclusiveMaximum) {
      issues.push({ path, message: `must be < ${constraints.exclusiveMaximum}` });
    }
    if (constraints.multipleOf !== undefined) {
      const quotient = numeric / constraints.multipleOf;
      // Tolerate floating point noise such as 0.3 / 0.1 = 2.9999999999999996.
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
        issues.push({ path, message: `must be a multiple of ${constraints.multipleOf}` });
      }
    }
  };
}

export const boolean: Validator = (value, path, issues) => {
  if (typeof value !== "boolean") {
    issues.push({ path, message: `must be a boolean, got ${describe(value)}` });
  }
};

export const nullValue: Validator = (value, path, issues) => {
  if (value !== null) {
    issues.push({ path, message: `must be null, got ${describe(value)}` });
  }
};

/** Accepts every value: schemas TypeScript cannot express, and binary bodies. */
export const anything: Validator = () => {};

export const nothing: Validator = (_value, path, issues) => {
  issues.push({ path, message: "no value is allowed here" });
};

type Scalar = string | number | boolean | null;

export function literal(expected: Scalar): Validator {
  return (value, path, issues) => {
    if (value !== expected) {
      issues.push({ path, message: `must be ${JSON.stringify(expected)}` });
    }
  };
}

export function oneOfValues(allowed: Scalar[]): Validator {
  return (value, path, issues) => {
    if (!allowed.includes(value as Scalar)) {
      issues.push({ path, message: `must be one of ${allowed.map((item) => JSON.stringify(item)).join(", ")}` });
    }
  };
}

// ---------------------------------------------------------------- structures

/** Key-order independent JSON text, so uniqueItems compares values, not object key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return unsafeIntegerDigits(value) ?? JSON.stringify(value);
}

function checkItems(items: unknown[], path: string, issues: Issue[], constraints: Constraints): void {
  if (constraints.minItems !== undefined && items.length < constraints.minItems) {
    issues.push({ path, message: `must have at least ${constraints.minItems} items` });
  }
  if (constraints.maxItems !== undefined && items.length > constraints.maxItems) {
    issues.push({ path, message: `must have at most ${constraints.maxItems} items` });
  }
  if (constraints.uniqueItems === true) {
    const seen = new Set<string>();
    for (const item of items) {
      const text = canonical(item);
      if (seen.has(text)) {
        issues.push({ path, message: "must not contain duplicate items" });
        break;
      }
      seen.add(text);
    }
  }
}

export function array(itemValidator: Validator, constraints: Constraints = {}): Validator {
  return (value, path, issues, direction) => {
    if (!Array.isArray(value)) {
      issues.push({ path, message: `must be an array, got ${describe(value)}` });
      return;
    }
    checkItems(value, path, issues, constraints);
    value.forEach((item, index) => itemValidator(item, childPath(path, index), issues, direction));
  };
}

/** `rest`: a validator for items after the prefix, `false` = none allowed, `null` = anything allowed. */
export function tuple(prefix: Validator[], rest: Validator | false | null, constraints: Constraints = {}): Validator {
  return (value, path, issues, direction) => {
    if (!Array.isArray(value)) {
      issues.push({ path, message: `must be an array, got ${describe(value)}` });
      return;
    }
    checkItems(value, path, issues, constraints);
    value.forEach((item, index) => {
      const itemPath = childPath(path, index);
      if (index < prefix.length) {
        prefix[index]!(item, itemPath, issues, direction);
      } else if (rest === false) {
        issues.push({ path: itemPath, message: `must have at most ${prefix.length} items` });
      } else if (rest !== null) {
        rest(item, itemPath, issues, direction);
      }
    });
  };
}

/** `additional`: a validator for undeclared properties, `false` = none allowed, `true` = anything allowed. */
export function object(properties: Record<string, PropertyRule>, additional: Validator | boolean = true, constraints: Constraints = {}): Validator {
  return (value, path, issues, direction) => {
    if (!isPlainObject(value)) {
      issues.push({ path, message: `must be an object, got ${describe(value)}` });
      return;
    }
    const keys = Object.keys(value);
    if (constraints.minProperties !== undefined && keys.length < constraints.minProperties) {
      issues.push({ path, message: `must have at least ${constraints.minProperties} properties` });
    }
    if (constraints.maxProperties !== undefined && keys.length > constraints.maxProperties) {
      issues.push({ path, message: `must have at most ${constraints.maxProperties} properties` });
    }
    for (const [name, rule] of Object.entries(properties)) {
      if (!Object.hasOwn(value, name)) {
        const isRequest = direction === "request";
        const sentByOtherSide = (isRequest && rule.readOnly === true) || (!isRequest && rule.writeOnly === true);
        if (rule.required && !sentByOtherSide) {
          issues.push({ path: childPath(path, name), message: "is required" });
        }
        continue;
      }
      rule.validator(value[name], childPath(path, name), issues, direction);
    }
    for (const key of keys) {
      if (Object.hasOwn(properties, key)) {
        continue;
      }
      if (additional === false) {
        issues.push({ path: childPath(path, key), message: "is not allowed" });
      } else if (additional !== true) {
        additional(value[key], childPath(path, key), issues, direction);
      }
    }
  };
}

// ---------------------------------------------------------------- composition

export function allOf(members: Validator[]): Validator {
  return (value, path, issues, direction) => {
    for (const member of members) {
      member(value, path, issues, direction);
    }
  };
}

/** Runs one member on its own and reports whether it accepted the value. */
function accepts(member: Validator, value: unknown, path: string, direction: Direction | undefined): { valid: boolean; issues: Issue[] } {
  const memberIssues: Issue[] = [];
  member(value, path, memberIssues, direction);
  return { valid: memberIssues.length === 0, issues: memberIssues };
}

export function anyOf(members: Validator[]): Validator {
  return (value, path, issues, direction) => {
    const results = members.map((member) => accepts(member, value, path, direction));
    if (results.some((result) => result.valid)) {
      return;
    }
    // Report the closest member: the one with the fewest issues.
    const closest = results.reduce((best, result) => (result.issues.length < best.issues.length ? result : best));
    issues.push({ path, message: `must match at least one of ${members.length} alternatives` }, ...closest.issues);
  };
}

export type Discriminator = { property: string; mapping: Record<string, Validator> };

export function oneOf(members: Validator[], discriminator?: Discriminator): Validator {
  return (value, path, issues, direction) => {
    if (discriminator !== undefined && isPlainObject(value)) {
      const tag = value[discriminator.property];
      const selected = typeof tag === "string" && Object.hasOwn(discriminator.mapping, tag) ? discriminator.mapping[tag] : undefined;
      if (selected === undefined) {
        const allowed = Object.keys(discriminator.mapping).map((key) => JSON.stringify(key)).join(", ");
        issues.push({ path: childPath(path, discriminator.property), message: `must be one of ${allowed}` });
        return;
      }
      selected(value, path, issues, direction);
      return;
    }
    const results = members.map((member) => accepts(member, value, path, direction));
    const matches = results.filter((result) => result.valid).length;
    if (matches === 1) {
      return;
    }
    if (matches > 1) {
      issues.push({ path, message: `must match exactly one of ${members.length} alternatives, matched ${matches}` });
      return;
    }
    const closest = results.reduce((best, result) => (result.issues.length < best.issues.length ? result : best));
    issues.push({ path, message: `must match exactly one of ${members.length} alternatives` }, ...closest.issues);
  };
}

/** Defers a reference, so recursive and mutually recursive schemas (across modules too) can be defined. */
export function lazy(resolveValidator: () => Validator): Validator {
  return (value, path, issues, direction) => resolveValidator()(value, path, issues, direction);
}
