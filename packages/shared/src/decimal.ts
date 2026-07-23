import Decimal from "decimal.js";

Decimal.set({
  precision: 28,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -9,
  toExpPos: 21,
});

export { Decimal };

export function d(value: string | number | Decimal): Decimal {
  return value instanceof Decimal ? value : new Decimal(value);
}

export function sumDecimals(values: Array<string | number | Decimal>): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(d(v)), d(0));
}

export function floorToStep(value: Decimal, step: Decimal): Decimal {
  if (step.lte(0)) {
    throw new Error("step must be positive");
  }
  return value.div(step).toDecimalPlaces(0, Decimal.ROUND_FLOOR).mul(step);
}

export function ceilToStep(value: Decimal, step: Decimal): Decimal {
  if (step.lte(0)) {
    throw new Error("step must be positive");
  }
  return value.div(step).toDecimalPlaces(0, Decimal.ROUND_CEIL).mul(step);
}

export function roundToPrecision(value: Decimal, precision: number): Decimal {
  return value.toDecimalPlaces(precision, Decimal.ROUND_HALF_UP);
}

export function isPositiveFinite(value: Decimal): boolean {
  return value.isFinite() && value.gt(0);
}

export function assertFinitePositive(value: Decimal, label: string): void {
  if (!value.isFinite() || value.isNaN()) {
    throw new Error(`${label} must be a finite number`);
  }
  if (value.lt(0)) {
    throw new Error(`${label} cannot be negative`);
  }
}
