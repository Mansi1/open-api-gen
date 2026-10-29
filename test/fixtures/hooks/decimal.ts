// A user-defined transformer for the T3 hook tests: int64 cents as a tiny Decimal value object.
export class Decimal {
  constructor(readonly digits: string) {}

  toString(): string {
    return this.digits;
  }
}

export function toDecimal(wire: unknown): unknown {
  if (typeof wire === "number" || typeof wire === "bigint") {
    return new Decimal(String(wire));
  }
  return wire;
}

export function fromDecimal(app: unknown): unknown {
  if (app instanceof Decimal) {
    return BigInt(app.digits);
  }
  return app;
}
