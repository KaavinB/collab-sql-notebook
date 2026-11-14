/** Command-line parsing shared by both benchmarks: strict, with clear errors. */
import { parseArgs, type ParseArgsConfig } from "node:util";

export class UsageError extends Error {}

/** "2,5,10" -> [2, 5, 10]: positive integers, strictly increasing, no duplicates. */
export function parseSteps(value: string, name: string, { allowZero = false } = {}): number[] {
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => !/^\d+$/.test(part))) {
    throw new UsageError(`--${name} must be a comma-separated list of integers, got "${value}"`);
  }
  const steps = parts.map(Number);
  for (const [i, step] of steps.entries()) {
    if (!Number.isSafeInteger(step) || step < (allowZero ? 0 : 1)) {
      throw new UsageError(`--${name}: ${step} is out of range`);
    }
    if (i > 0 && step <= steps[i - 1]!) {
      throw new UsageError(`--${name} must be strictly increasing, got "${value}"`);
    }
  }
  return steps;
}

/** A finite number within [min, max]. */
export function parseNumber(value: string, name: string, min: number, max: number): number {
  const number = Number(value);
  if (value.trim() === "" || !Number.isFinite(number) || number < min || number > max) {
    throw new UsageError(`--${name} must be a number from ${min} to ${max}, got "${value}"`);
  }
  return number;
}

export function parseInteger(value: string, name: string, min: number, max: number): number {
  const number = parseNumber(value, name, min, max);
  if (!Number.isInteger(number)) throw new UsageError(`--${name} must be an integer`);
  return number;
}

/** A short free-text label for the run (kept in results; becomes part of nothing else). */
export function parseLabel(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!/^[\w .:-]{1,60}$/.test(value)) {
    throw new UsageError("--label: up to 60 letters, digits, spaces and . _ : -");
  }
  return value;
}

type Options = NonNullable<ParseArgsConfig["options"]>;

/** Parses argv against `options`, turning node's errors into a UsageError. */
export function parse<T extends Options>(argv: string[], options: T) {
  try {
    return parseArgs({ args: argv, options, strict: true, allowPositionals: false }).values;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}
