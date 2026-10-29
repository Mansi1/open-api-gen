// Copied verbatim into every generated client as runtime/json.ts. It must not import anything,
// and it must run unchanged in browsers, Node.js and Bun.
// VERIFIED: test/codecs.test.ts and test/services.test.ts cover exact int64 and the number fallback.

type ReviverContext = { source?: string };
type RawJsonFactory = (text: string) => unknown;

// The registry symbol lets runtime/validation.ts recognize the marker without importing this module.
const UNSAFE_INTEGER = Symbol.for("open-api-gen.unsafeInteger");

/** An integer beyond 2^53 as its exact digits, until runtime/transform.ts turns it into bigint (int64) or number. */
export type UnsafeInteger = { readonly [UNSAFE_INTEGER]: string };

export function isUnsafeInteger(value: unknown): value is UnsafeInteger {
  return typeof value === "object" && value !== null && UNSAFE_INTEGER in value;
}

export function unsafeIntegerDigits(value: UnsafeInteger): string {
  return value[UNSAFE_INTEGER];
}

/**
 * JSON.parse that keeps integers beyond 2^53 exact, as UnsafeInteger markers: the int64 transformer makes them
 * bigint, and settleUnsafeIntegers makes every other one a number, as the field's type says.
 * It relies on the reviver's source text (TC39 "JSON.parse source text access"); on a runtime without it,
 * large integers arrive rounded and the int64 transformer reports them instead of passing a wrong value on.
 */
export function parseJson(text: string): unknown {
  return JSON.parse(text, function revive(this: unknown, _key: string, value: unknown, context?: ReviverContext) {
    if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value) && context?.source !== undefined) {
      // The source text of an integer literal may still use exponent notation (1e20); BigInt cannot read that.
      if (/^-?\d+$/.test(context.source)) {
        return Object.freeze({ [UNSAFE_INTEGER]: context.source });
      }
    }
    return value;
  });
}

/** Replaces every UnsafeInteger left in `value` (in place) with `convert(digits)`; returns the settled value. */
export function settleUnsafeIntegers(value: unknown, convert: (digits: string) => unknown = Number): unknown {
  if (isUnsafeInteger(value)) {
    return convert(unsafeIntegerDigits(value));
  }
  const isContainer = Array.isArray(value) || (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype);
  if (!isContainer) {
    return value;
  }
  const container = value as Record<string, unknown>;
  for (const key of Object.keys(container)) {
    const settled = settleUnsafeIntegers(container[key], convert);
    if (settled !== container[key]) {
      Object.defineProperty(container, key, { value: settled, enumerable: true, writable: true, configurable: true });
    }
  }
  return value;
}

/** JSON.stringify that writes bigint values (and parseJson's markers) as plain JSON numbers, without losing digits. */
export function stringifyJson(value: unknown): string {
  const rawJson = (JSON as unknown as { rawJSON?: RawJsonFactory }).rawJSON;
  return JSON.stringify(value, (_key, unconverted: unknown) => {
    const item = isUnsafeInteger(unconverted) ? BigInt(unsafeIntegerDigits(unconverted)) : unconverted;
    if (typeof item !== "bigint") {
      return item;
    }
    if (rawJson !== undefined) {
      return rawJson(item.toString());
    }
    if (item >= BigInt(Number.MIN_SAFE_INTEGER) && item <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(item);
    }
    throw new RangeError(`cannot send ${item} exactly: this JavaScript runtime has no JSON.rawJSON`);
  });
}
