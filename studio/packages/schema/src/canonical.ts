import type { AssetRef, Edge, Node, Scene, Stroke } from "./schema";

export const CANONICAL_VERSION = 1 as const;

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

export type CanonicalScene = {
  diagram?: Scene["diagram"];
  assets: AssetRef[];
  edges: Edge[];
  nodes: Node[];
  strokes: Stroke[];
  v: typeof CANONICAL_VERSION;
};

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(
    right,
    (character) => character.codePointAt(0)!,
  );
  const length = Math.min(leftPoints.length, rightPoints.length);

  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) {
      return difference;
    }
  }

  return leftPoints.length - rightPoints.length;
}

export function round2HalfAwayFromZero(value: number): number {
  if (!Number.isFinite(value)) {
    throw new CanonicalizationError(
      `Cannot canonicalize non-finite number: ${value}`,
    );
  }

  if (value === 0) {
    return 0;
  }

  // Above this magnitude the f64 spacing is already larger than 0.01, so a
  // division by 100 can only introduce precision loss.
  if (Math.abs(value) >= Number.MAX_SAFE_INTEGER / 100) {
    return value;
  }

  const [coefficient = "", exponentText] = Math.abs(value)
    .toString()
    .toLowerCase()
    .split("e");
  const exponent = exponentText ? Number.parseInt(exponentText, 10) : 0;
  const [integerPart = "", fractionPart = ""] = coefficient.split(".");
  const digitsText =
    `${integerPart}${fractionPart}`.replace(/^0+(?=\d)/, "") || "0";
  const scaledExponent = exponent - fractionPart.length + 2;
  const digits = BigInt(digitsText);

  let roundedHundredths: bigint;
  if (scaledExponent >= 0) {
    roundedHundredths = digits * 10n ** BigInt(scaledExponent);
  } else {
    const divisor = 10n ** BigInt(-scaledExponent);
    roundedHundredths = digits / divisor;
    const remainder = digits % divisor;
    if (remainder * 2n >= divisor) {
      roundedHundredths += 1n;
    }
  }

  const rounded = Number(roundedHundredths) / 100;
  if (value < 0) {
    return Object.is(-rounded, -0) ? 0 : -rounded;
  }

  return Object.is(rounded, -0) ? 0 : rounded;
}

function canonicalizeValue(value: unknown, path: string): CanonicalValue {
  if (value === null) {
    return null;
  }

  if (typeof value === "string") {
    return value.normalize("NFC");
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalizationError(
        `Cannot canonicalize non-finite number at ${path}: ${value}`,
      );
    }
    return round2HalfAwayFromZero(value);
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    const result: CanonicalValue[] = [];

    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        throw new CanonicalizationError(
          `Cannot canonicalize sparse array at ${path}`,
        );
      }
      result.push(canonicalizeValue(value[index], `${path}[${index}]`));
    }

    return result;
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalizationError(
        `Cannot canonicalize non-plain object at ${path}`,
      );
    }

    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new CanonicalizationError(
        `Cannot canonicalize symbol keys at ${path}`,
      );
    }

    const result = Object.create(null) as { [key: string]: CanonicalValue };
    const normalizedKeys = new Set<string>();
    const entries = Object.entries(value).sort(([left], [right]) =>
      compareUnicodeCodePoints(left, right),
    );

    for (const [rawKey, childValue] of entries) {
      if (childValue === undefined) {
        throw new CanonicalizationError(
          `Cannot canonicalize undefined value at ${path}.${rawKey}`,
        );
      }

      const key = rawKey.normalize("NFC");
      if (normalizedKeys.has(key)) {
        throw new CanonicalizationError(
          `Duplicate key after NFC normalization at ${path}: ${key}`,
        );
      }
      normalizedKeys.add(key);
      result[key] = canonicalizeValue(childValue, `${path}.${key}`);
    }

    return result;
  }

  throw new CanonicalizationError(
    `Cannot canonicalize unsupported value at ${path}: ${typeof value}`,
  );
}

function expandExponential(value: string): string {
  const [mantissa = "", exponentText = "0"] = value.toLowerCase().split("e");
  const exponent = Number.parseInt(exponentText, 10);
  const negative = mantissa.startsWith("-");
  const unsigned = negative ? mantissa.slice(1) : mantissa;
  const [integerPart = "", fractionPart = ""] = unsigned.split(".");
  const digits = `${integerPart}${fractionPart}`.replace(/^0+(?=\d)/, "");
  const decimalIndex = integerPart.length + exponent;

  let fixed: string;
  if (decimalIndex <= 0) {
    fixed = `0.${"0".repeat(-decimalIndex)}${digits}`;
  } else if (decimalIndex >= digits.length) {
    fixed = `${digits}${"0".repeat(decimalIndex - digits.length)}`;
  } else {
    fixed = `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  }

  return negative ? `-${fixed}` : fixed;
}

function formatCanonicalNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalizationError(
      `Cannot serialize non-finite number: ${value}`,
    );
  }

  if (value === 0) {
    return "0";
  }

  const raw = value.toString();
  const fixed = raw.includes("e") ? expandExponential(raw) : raw;

  if (!fixed.includes(".")) {
    return fixed;
  }

  return fixed.replace(/0+$/, "").replace(/\.$/, "");
}

function serializeCanonicalValue(value: CanonicalValue): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    return formatCanonicalNumber(value);
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(serializeCanonicalValue).join(",")}]`;
  }

  const entries = Object.entries(value).sort(([left], [right]) =>
    compareUnicodeCodePoints(left, right),
  );
  return `{${entries
    .map(
      ([key, childValue]) =>
        `${JSON.stringify(key)}:${serializeCanonicalValue(childValue)}`,
    )
    .join(",")}}`;
}

export function canonicalizeJsonValue(value: unknown): unknown {
  return canonicalizeValue(value, "$");
}

export function canonicalJson(value: unknown): string {
  return serializeCanonicalValue(canonicalizeValue(value, "$"));
}

export function canonicalizeScene(scene: Scene): CanonicalScene {
  const normalized = canonicalizeValue(scene, "$") as Scene;

  return {
    ...(normalized.diagram ? { diagram: normalized.diagram } : {}),
    assets: [...normalized.assets].sort(
      (left, right) =>
        compareUnicodeCodePoints(left.asset_id, right.asset_id) ||
        left.z - right.z,
    ),
    edges: [...normalized.edges].sort((left, right) =>
      compareUnicodeCodePoints(left.id, right.id),
    ),
    nodes: [...normalized.nodes].sort((left, right) =>
      compareUnicodeCodePoints(left.id, right.id),
    ),
    strokes: [...normalized.strokes],
    v: CANONICAL_VERSION,
  };
}

export function canonicalSceneJson(scene: Scene): string {
  return canonicalJson(canonicalizeScene(scene));
}
