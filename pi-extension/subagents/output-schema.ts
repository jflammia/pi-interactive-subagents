/**
 * Structured output validation for subagents.
 *
 * An agent definition can declare an `outputSchema` (a JSON Schema object) in
 * its frontmatter. After the subagent exits, its final assistant message is
 * parsed as JSON and validated against this schema. If validation succeeds,
 * the parsed JSON is returned to the parent as `structuredOutput` in the
 * result details, enabling programmatic workflow decisions. If it fails, a
 * validation error is returned instead.
 *
 * The schema is stored in the loadout sidecar so resume paths can re-validate
 * without re-reading the agent definition.
 */

/**
 * Validate a JSON value against a JSON Schema object.
 *
 * This is a lightweight validator — it supports the subset of JSON Schema
 * that's useful for subagent structured output: type, properties, required,
 * items, enum, oneOf, anyOf, allOf, additionalProperties. It is NOT a full
 * JSON Schema implementation (no $ref, format, pattern, etc.) — those add
 * complexity and dependency weight that doesn't pay for itself here.
 *
 * Returns null on success, or an error message string on failure.
 */
export function validateJsonSchema(value: unknown, schema: unknown): string | null {
  if (!schema || typeof schema !== "object") return null; // no schema = no validation
  return validateValue(value, schema as Record<string, unknown>, "");
}

function validateValue(value: unknown, schema: Record<string, unknown>, path: string): string | null {
  const type = schema["type"];

  // ── type check ──
  if (typeof type === "string") {
    const err = checkType(value, type, path);
    if (err) return err;
  } else if (Array.isArray(type)) {
    let matched = false;
    for (const t of type) {
      if (typeof t === "string" && checkType(value, t, path) === null) {
        matched = true;
        break;
      }
    }
    if (!matched) return `${path || "value"}: expected one of types [${type.join(", ")}], got ${typeName(value)}`;
  }

  // ── enum ──
  if (Array.isArray(schema["enum"])) {
    const allowed = schema["enum"] as unknown[];
    if (!allowed.some((v) => deepEqual(v, value))) {
      return `${path || "value"}: value not in enum [${allowed.map(JSON.stringify).join(", ")}]`;
    }
  }

  // ── const ──
  if ("const" in schema) {
    if (!deepEqual(schema["const"], value)) {
      return `${path || "value"}: expected const ${JSON.stringify(schema["const"])}, got ${JSON.stringify(value)}`;
    }
  }

  // ── object ──
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const properties = schema["properties"];
    const required = schema["required"];

    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key !== "string") continue;
        if (!(key in obj)) {
          return `${path || "object"}: missing required property "${key}"`;
        }
      }
    }

    if (properties && typeof properties === "object") {
      for (const [key, subSchema] of Object.entries(properties as Record<string, unknown>)) {
        if (key in obj && subSchema && typeof subSchema === "object") {
          const err = validateValue(obj[key], subSchema as Record<string, unknown>, path ? `${path}.${key}` : key);
          if (err) return err;
        }
      }
    }

    const additionalProps = schema["additionalProperties"];
    if (additionalProps === false) {
      const knownKeys = new Set(Object.keys((properties as Record<string, unknown>) ?? {}));
      for (const key of Object.keys(obj)) {
        if (!knownKeys.has(key)) {
          return `${path || "object"}: additional property "${key}" not allowed`;
        }
      }
    } else if (additionalProps && typeof additionalProps === "object") {
      const knownKeys = new Set(Object.keys((properties as Record<string, unknown>) ?? {}));
      for (const key of Object.keys(obj)) {
        if (!knownKeys.has(key)) {
          const err = validateValue(obj[key], additionalProps as Record<string, unknown>, path ? `${path}.${key}` : key);
          if (err) return err;
        }
      }
    }
  }

  // ── array ──
  if (Array.isArray(value)) {
    const items = schema["items"];
    if (items && typeof items === "object") {
      for (let i = 0; i < value.length; i++) {
        const err = validateValue(value[i], items as Record<string, unknown>, `${path}[${i}]`);
        if (err) return err;
      }
    }

    const minItems = schema["minItems"];
    if (typeof minItems === "number" && value.length < minItems) {
      return `${path || "array"}: expected at least ${minItems} items, got ${value.length}`;
    }

    const maxItems = schema["maxItems"];
    if (typeof maxItems === "number" && value.length > maxItems) {
      return `${path || "array"}: expected at most ${maxItems} items, got ${value.length}`;
    }
  }

  // ── string constraints ──
  if (typeof value === "string") {
    const minLength = schema["minLength"];
    if (typeof minLength === "number" && value.length < minLength) {
      return `${path || "string"}: expected min length ${minLength}, got ${value.length}`;
    }
    const maxLength = schema["maxLength"];
    if (typeof maxLength === "number" && value.length > maxLength) {
      return `${path || "string"}: expected max length ${maxLength}, got ${value.length}`;
    }
    const pattern = schema["pattern"];
    if (typeof pattern === "string") {
      try {
        if (!new RegExp(pattern).test(value)) {
          return `${path || "string"}: does not match pattern /${pattern}/`;
        }
      } catch {
        // Invalid pattern — skip rather than crash.
      }
    }
  }

  // ── number constraints ──
  if (typeof value === "number") {
    const minimum = schema["minimum"];
    if (typeof minimum === "number" && value < minimum) {
      return `${path || "number"}: expected >= ${minimum}, got ${value}`;
    }
    const maximum = schema["maximum"];
    if (typeof maximum === "number" && value > maximum) {
      return `${path || "number"}: expected <= ${maximum}, got ${value}`;
    }
  }

  // ── composition: oneOf / anyOf / allOf ──
  const oneOf = schema["oneOf"];
  if (Array.isArray(oneOf)) {
    let matches = 0;
    for (const sub of oneOf) {
      if (sub && typeof sub === "object" && validateValue(value, sub as Record<string, unknown>, path) === null) {
        matches++;
      }
    }
    if (matches !== 1) {
      return `${path || "value"}: matched ${matches} of oneOf schemas (expected exactly 1)`;
    }
  }

  const anyOf = schema["anyOf"];
  if (Array.isArray(anyOf)) {
    let matched = false;
    for (const sub of anyOf) {
      if (sub && typeof sub === "object" && validateValue(value, sub as Record<string, unknown>, path) === null) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      return `${path || "value"}: does not match any anyOf schema`;
    }
  }

  const allOf = schema["allOf"];
  if (Array.isArray(allOf)) {
    for (const sub of allOf) {
      if (sub && typeof sub === "object") {
        const err = validateValue(value, sub as Record<string, unknown>, path);
        if (err) return err;
      }
    }
  }

  return null;
}

function checkType(value: unknown, type: string, path: string): string | null {
  switch (type) {
    case "string":
      return typeof value === "string" ? null : `${path || "value"}: expected string, got ${typeName(value)}`;
    case "number":
    case "integer":
      if (typeof value !== "number") return `${path || "value"}: expected ${type}, got ${typeName(value)}`;
      if (type === "integer" && !Number.isInteger(value)) return `${path || "value"}: expected integer, got ${value}`;
      return null;
    case "boolean":
      return typeof value === "boolean" ? null : `${path || "value"}: expected boolean, got ${typeName(value)}`;
    case "object":
      return (value && typeof value === "object" && !Array.isArray(value)) ? null : `${path || "value"}: expected object, got ${typeName(value)}`;
    case "array":
      return Array.isArray(value) ? null : `${path || "value"}: expected array, got ${typeName(value)}`;
    case "null":
      return value === null ? null : `${path || "value"}: expected null, got ${typeName(value)}`;
    default:
      return null; // unknown type — don't block validation
  }
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== (b as unknown[]).length) return false;
    return a.every((v, i) => deepEqual(v, (b as unknown[])[i]));
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Try to extract and validate structured output from a subagent's final message.
 *
 * The agent is expected to produce a JSON object (or a fenced ```json code block
 * containing one) as its final assistant message. We try, in order:
 *   1. Parse the whole message as JSON.
 *   2. Extract the first ```json ... ``` fenced block and parse that.
 *   3. Find the first `{` ... `}` substring and parse that.
 *
 * Returns `{ ok: true, value }` on success, `{ ok: false, error }` on failure.
 */
export function extractStructuredOutput(
  finalMessage: string,
  schema: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const jsonCandidates: string[] = [finalMessage.trim()];

  // Fenced ```json block
  const fenceMatch = finalMessage.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch?.[1]) jsonCandidates.push(fenceMatch[1].trim());

  // First { ... } substring
  const braceStart = finalMessage.indexOf("{");
  const braceEnd = finalMessage.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) {
    jsonCandidates.push(finalMessage.slice(braceStart, braceEnd + 1).trim());
  }

  for (const candidate of jsonCandidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const err = validateJsonSchema(parsed, schema);
    if (err === null) return { ok: true, value: parsed };
    // If it parsed but didn't validate, return the validation error immediately
    // — don't keep trying weaker extractions, since those are likely wrong too.
    return { ok: false, error: err };
  }

  return {
    ok: false,
    error: "Subagent's final message did not contain parseable JSON. Expected a JSON object matching the agent's outputSchema.",
  };
}
