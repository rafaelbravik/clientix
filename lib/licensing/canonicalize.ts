/**
 * Deterministic JSON Canonicalization based on RFC 8785 (JSON Canonicalization Scheme - JCS).
 *
 * Guarantees that equivalent JSON structures produce byte-identical UTF-8 string output,
 * regardless of object key order, whitespace, or floating point representation quirks.
 */

function canonicalizeValue(val: unknown): string {
  if (val === null) {
    return "null";
  }

  if (typeof val === "boolean") {
    return val ? "true" : "false";
  }

  if (typeof val === "number") {
    if (!Number.isFinite(val)) {
      throw new TypeError("Valores numéricos infinitos ou NaN não são suportados na canonicalização");
    }
    // Per RFC 8785 §3.2.2.3: negative zero (-0) MUST be serialized as "0"
    if (Object.is(val, -0) || val === 0) {
      return "0";
    }
    return JSON.stringify(val);
  }

  if (typeof val === "string") {
    return JSON.stringify(val);
  }

  if (Array.isArray(val)) {
    const items = val.map((item) => canonicalizeValue(item));
    return `[${items.join(",")}]`;
  }

  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    // In RFC 8785, keys are sorted by their UTF-16 code unit values
    const sortedKeys = Object.keys(obj).sort((a, b) => {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    });

    const entries: string[] = [];
    for (const key of sortedKeys) {
      const v = obj[key];
      // Skip undefined fields (JSON.stringify convention)
      if (v !== undefined) {
        entries.push(`${JSON.stringify(key)}:${canonicalizeValue(v)}`);
      }
    }
    return `{${entries.join(",")}}`;
  }

  throw new TypeError(`Tipo não suportado para canonicalização: ${typeof val}`);
}

/**
 * Returns the RFC 8785 canonical JSON string for any serializable data structure.
 */
export function canonicalizeJson(value: unknown): string {
  return canonicalizeValue(value);
}

/**
 * Returns a Buffer of the canonicalized JSON encoded as UTF-8 bytes.
 */
export function canonicalizeToBuffer(value: unknown): Buffer {
  return Buffer.from(canonicalizeJson(value), "utf-8");
}
