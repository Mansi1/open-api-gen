// Copied verbatim into every generated client as runtime/transform.ts. It imports only its sibling runtime
// module, and it must run unchanged in browsers, Node.js and Bun.
// VERIFIED: test/codecs.test.ts round-trips every transformer on fixture samples.
import { isUnsafeInteger, settleUnsafeIntegers, unsafeIntegerDigits } from "./json.js";
import { validate, type Validator } from "./validation.js";

/** Converts one value between its wire shape (JSON) and its App shape (what `transform: true` hands out). */
export type Transformer = {
  decode: (wire: unknown, path: string) => unknown;
  encode: (app: unknown, path: string) => unknown;
};

/** A value that could not be converted; `path` is a JSON Pointer into the value. */
export class TransformError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path === "" ? "value" : path}: ${message}`);
    this.name = "TransformError";
  }
}

function childPath(path: string, key: string | number): string {
  const token = String(key).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${token}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !isUnsafeInteger(value);
}

export const identity: Transformer = {
  decode: (wire) => wire,
  encode: (app) => app,
};

// ---------------------------------------------------------------- formats

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Date rolls impossible days over (2024-02-30 → March 1); a real calendar date survives the round trip. */
function isCalendarDate(fullDate: string): boolean {
  const parsed = new Date(`${fullDate}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === fullDate;
}

export const dateTime: Transformer = {
  decode(wire, path) {
    if (typeof wire !== "string") {
      return wire;
    }
    const parsed = new Date(wire);
    if (Number.isNaN(parsed.getTime()) || !isCalendarDate(wire.slice(0, 10))) {
      throw new TransformError(path, `${JSON.stringify(wire)} is not a valid date-time`);
    }
    return parsed;
  },
  encode(app, path) {
    if (!(app instanceof Date)) {
      return app;
    }
    if (Number.isNaN(app.getTime())) {
      throw new TransformError(path, "cannot send an invalid Date");
    }
    return app.toISOString();
  },
};

/** A full-date (YYYY-MM-DD) is a Date at midnight UTC, so it round-trips in every time zone. */
export const date: Transformer = {
  decode(wire, path) {
    if (typeof wire !== "string") {
      return wire;
    }
    const parsed = new Date(`${wire}T00:00:00Z`);
    if (!DATE_PATTERN.test(wire) || !isCalendarDate(wire)) {
      throw new TransformError(path, `${JSON.stringify(wire)} is not a valid date`);
    }
    return parsed;
  },
  encode(app, path) {
    if (!(app instanceof Date)) {
      return app;
    }
    if (Number.isNaN(app.getTime())) {
      throw new TransformError(path, "cannot send an invalid Date");
    }
    return app.toISOString().slice(0, 10);
  },
};

/** int64 as bigint. Large values arrive as bigint from runtime/json.ts parseJson; small ones as numbers. */
export const bigint: Transformer = {
  decode(wire, path) {
    if (isUnsafeInteger(wire)) {
      return BigInt(unsafeIntegerDigits(wire));
    }
    if (typeof wire === "bigint") {
      return wire;
    }
    if (typeof wire !== "number") {
      return wire;
    }
    if (!Number.isSafeInteger(wire)) {
      throw new TransformError(path, `${wire} lost precision while parsing; this JavaScript runtime cannot read int64 values exactly`);
    }
    return BigInt(wire);
  },
  // runtime/json.ts stringifyJson writes the bigint as a plain JSON number.
  encode: (app) => app,
};

/** A transformer from the config's `transformers`, implemented by user code. */
export function hook(decode: (wire: unknown) => unknown, encode: (app: unknown) => unknown): Transformer {
  return {
    // User code receives integers beyond 2^53 as bigint, never as the lossless parse's marker.
    decode: (wire) => decode(settleUnsafeIntegers(wire, BigInt)),
    encode: (app) => encode(app),
  };
}

// ---------------------------------------------------------------- structures

export function array(item: Transformer): Transformer {
  return {
    decode(wire, path) {
      if (!Array.isArray(wire)) {
        return wire;
      }
      return wire.map((element, index) => item.decode(element, childPath(path, index)));
    },
    encode(app, path) {
      if (!Array.isArray(app)) {
        return app;
      }
      return app.map((element, index) => item.encode(element, childPath(path, index)));
    },
  };
}

export function tuple(prefix: Transformer[], rest: Transformer): Transformer {
  const transformerAt = (index: number) => prefix[index] ?? rest;
  return {
    decode(wire, path) {
      if (!Array.isArray(wire)) {
        return wire;
      }
      return wire.map((element, index) => transformerAt(index).decode(element, childPath(path, index)));
    },
    encode(app, path) {
      if (!Array.isArray(app)) {
        return app;
      }
      return app.map((element, index) => transformerAt(index).encode(element, childPath(path, index)));
    },
  };
}

export type PropertyTransformer = { appName: string; transformer: Transformer };

/**
 * Renames declared properties and converts their values. Undeclared properties (maps, additionalProperties)
 * keep their keys and go through `additional`.
 */
export function object(properties: Record<string, PropertyTransformer>, additional: Transformer = identity): Transformer {
  const wireNameByAppName = new Map(Object.entries(properties).map(([wireName, property]) => [property.appName, wireName]));
  return {
    decode(wire, path) {
      if (!isPlainObject(wire)) {
        return wire;
      }
      const app: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(wire)) {
        const property = Object.hasOwn(properties, key) ? properties[key] : undefined;
        if (property !== undefined) {
          setOwn(app, property.appName, property.transformer.decode(value, childPath(path, key)));
        } else {
          setOwn(app, key, additional.decode(value, childPath(path, key)));
        }
      }
      return app;
    },
    encode(app, path) {
      if (!isPlainObject(app)) {
        return app;
      }
      const wire: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(app)) {
        const wireName = wireNameByAppName.get(key);
        if (wireName !== undefined) {
          setOwn(wire, wireName, properties[wireName]!.transformer.encode(value, childPath(path, key)));
        } else {
          setOwn(wire, key, additional.encode(value, childPath(path, key)));
        }
      }
      return wire;
    },
  };
}

/** Assignment would turn a "__proto__" key from the wire into the object's prototype; defining keeps it a plain key. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

// ---------------------------------------------------------------- composition

/** Each member converts the properties it knows; unknown keys pass through the others untouched. */
export function allOf(members: Transformer[]): Transformer {
  return {
    decode(wire, path) {
      let current = wire;
      for (const member of members) {
        current = member.decode(current, path);
      }
      return current;
    },
    encode(app, path) {
      let current = app;
      for (const member of members) {
        current = member.encode(current, path);
      }
      return current;
    },
  };
}

export type UnionMember = { validator: Validator; transformer: Transformer };
export type UnionDiscriminator = { property: string; mapping: Record<string, Transformer> };

/**
 * Converts with the member the value belongs to: by discriminator when the schema has one, otherwise the first
 * member whose wire validator accepts the value. Encoding cannot validate App values, so without a discriminator
 * it tries each member and keeps the first that converts without an error.
 */
export function union(members: UnionMember[], discriminator?: UnionDiscriminator): Transformer {
  const byTag = (value: unknown): Transformer | undefined => {
    if (discriminator === undefined || !isPlainObject(value)) {
      return undefined;
    }
    const tag = value[discriminator.property];
    return typeof tag === "string" && Object.hasOwn(discriminator.mapping, tag) ? discriminator.mapping[tag] : undefined;
  };
  return {
    decode(wire, path) {
      const tagged = byTag(wire);
      if (tagged !== undefined) {
        return tagged.decode(wire, path);
      }
      const member = members.find((candidate) => validate(candidate.validator, wire, "response").length === 0);
      return (member?.transformer ?? identity).decode(wire, path);
    },
    encode(app, path) {
      const tagged = byTag(app);
      if (tagged !== undefined) {
        return tagged.encode(app, path);
      }
      for (const member of members) {
        try {
          const encoded = member.transformer.encode(app, path);
          if (validate(member.validator, encoded, "request").length === 0) {
            return encoded;
          }
        } catch {
          // Not this member; try the next one.
        }
      }
      return app;
    },
  };
}

/** Defers a reference, so recursive and mutually recursive schemas (across modules too) can be defined. */
export function lazy(resolveTransformer: () => Transformer): Transformer {
  return {
    decode: (wire, path) => resolveTransformer().decode(wire, path),
    encode: (app, path) => resolveTransformer().encode(app, path),
  };
}
