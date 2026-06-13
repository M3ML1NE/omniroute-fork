/**
 * GigaChat function-parameter JSON Schema normalizer.
 *
 * GigaChat's function-calling validator is stricter than OpenAI's and rejects
 * several JSON Schema shapes that OpenAI/Anthropic/MCP tools routinely emit. The
 * most common failure is `[422]: Field 'properties.<x>.properties' is missing`:
 * GigaChat requires EVERY `type: "object"` node to declare a `properties` field,
 * even when empty, whereas OpenAI treats a missing `properties` as `{}`.
 *
 * This module ports the transformation that ai-forever/gpt2giga applies
 * (`resolve_schema_refs` + `normalize_json_schema`) so our converter produces
 * schemas GigaChat accepts. The rules, in order:
 *   1. Resolve `$ref`/`$defs` (GigaChat does not support them) by inlining.
 *   2. Flatten `anyOf`/`oneOf` to the first non-null variant (no union support).
 *   3. Collapse `type: ["string", "null"]` arrays to the first non-null type.
 *   4. Force `properties: {}` on every object node that lacks it (the 422 fix).
 *   5. Infer a missing `type` from structure (properties→object, items→array,
 *      enum→scalar) so untyped property schemas become concrete.
 *   6. Ensure array `items` is an object schema; default missing items to string.
 *   7. Strip `format` values GigaChat does not accept (keeps date/date-time/time).
 */

type JsonRecord = Record<string, unknown>;

const MAX_RECURSION_DEPTH = 64;
const GIGACHAT_ALLOWED_FORMATS = new Set(["date", "date-time", "time"]);

function isPlainObject(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Phase 1 — inline `$ref: "#/$defs/Name"` (and `#/definitions/Name`) using the
 * top-level `$defs`/`definitions`, and flatten `anyOf`/`oneOf` to the first
 * non-null variant. Returns a schema free of `$ref`/`$defs`/`definitions`.
 */
function resolveRefs(schema: unknown): unknown {
  if (!isPlainObject(schema)) return schema;

  const defs: JsonRecord = {
    ...(isPlainObject(schema.$defs) ? schema.$defs : {}),
    ...(isPlainObject(schema.definitions) ? schema.definitions : {}),
  };

  const resolve = (node: unknown, depth: number): unknown => {
    if (depth > MAX_RECURSION_DEPTH) return node;
    if (Array.isArray(node)) return node.map((item) => resolve(item, depth + 1));
    if (!isPlainObject(node)) return node;

    const ref = node.$ref;
    if (typeof ref === "string") {
      const name = ref.split("/").pop();
      if (name && Object.prototype.hasOwnProperty.call(defs, name)) {
        return resolve({ ...(defs[name] as JsonRecord) }, depth + 1);
      }
    }

    for (const unionKey of ["anyOf", "oneOf"] as const) {
      const variants = node[unionKey];
      if (Array.isArray(variants)) {
        const nonNull = variants.filter(
          (v) => !(isPlainObject(v) && v.type === "null")
        );
        if (nonNull.length > 0) {
          const merged = resolve(nonNull[0], depth + 1);
          if (isPlainObject(merged)) {
            for (const [k, v] of Object.entries(node)) {
              if (k === unionKey || k === "$defs" || k === "definitions") continue;
              if (!(k in merged)) merged[k] = resolve(v, depth + 1);
            }
          }
          return merged;
        }
        return { type: "null" };
      }
    }

    const out: JsonRecord = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$defs" || k === "definitions") continue;
      out[k] = resolve(v, depth + 1);
    }
    return out;
  };

  return resolve(schema, 0);
}

/** Infer a schema `type` from its structure when it is not declared. */
function inferMissingType(schema: JsonRecord, fallback: string): string {
  if ("properties" in schema || "additionalProperties" in schema) return "object";
  if ("items" in schema) return "array";
  const enumValues = schema.enum;
  if (Array.isArray(enumValues)) {
    for (const entry of enumValues) {
      if (typeof entry === "string") return "string";
      if (typeof entry === "boolean") return "boolean";
      if (typeof entry === "number") return Number.isInteger(entry) ? "integer" : "number";
    }
  }
  return fallback;
}

/** Ensure an object-typed node carries a `properties` field (the 422 fix). */
function ensureObjectProperties(schema: JsonRecord): void {
  if (schema.type === "object" && !isPlainObject(schema.properties)) {
    schema.properties = {};
  }
}

/**
 * Phase 2 — recursively normalize a (ref-free) schema for GigaChat.
 */
function normalize(schema: unknown, depth = 0): unknown {
  if (depth > MAX_RECURSION_DEPTH) return isPlainObject(schema) ? schema : {};
  if (!isPlainObject(schema)) return schema;

  const result: JsonRecord = { ...schema };

  // type: ["string", "null"] → "string"
  if (Array.isArray(result.type)) {
    const nonNull = (result.type as unknown[]).filter((t) => t !== "null");
    result.type = (nonNull.length > 0 ? nonNull[0] : result.type[0]) as unknown;
  }

  // Strip unsupported `format` values.
  if (typeof result.format === "string" && !GIGACHAT_ALLOWED_FORMATS.has(result.format)) {
    delete result.format;
  }

  // allOf: normalize members (kept; GigaChat tolerates intersection semantics).
  if (Array.isArray(result.allOf)) {
    result.allOf = result.allOf.map((item) => normalize(item, depth + 1));
  }

  // Infer a missing type before enforcing object/array invariants.
  if (typeof result.type !== "string") {
    result.type = inferMissingType(result, "object");
  }

  // Force properties:{} on objects lacking it.
  ensureObjectProperties(result);

  // Recurse into declared properties; make each property concrete.
  if (isPlainObject(result.properties)) {
    const normalizedProps: JsonRecord = {};
    for (const [key, value] of Object.entries(result.properties)) {
      let child = normalize(value, depth + 1);
      if (isPlainObject(child)) {
        if (typeof child.type !== "string") {
          child = { ...child, type: inferMissingType(child, "object") };
        }
        ensureObjectProperties(child as JsonRecord);
      }
      normalizedProps[key] = child;
    }
    result.properties = normalizedProps;
  }

  // Recurse into array items; guarantee a concrete object item schema.
  if ("items" in result) {
    if (Array.isArray(result.items)) {
      const first = (result.items as unknown[]).find(isPlainObject);
      result.items = first ? normalize(first, depth + 1) : { type: "string" };
    } else if (isPlainObject(result.items)) {
      result.items = normalize(result.items, depth + 1);
    }
  }
  if (result.type === "array") {
    if (!isPlainObject(result.items)) {
      result.items = { type: "string" };
    } else if (typeof (result.items as JsonRecord).type !== "string") {
      const items = { ...(result.items as JsonRecord) };
      items.type = inferMissingType(items, "string");
      ensureObjectProperties(items);
      result.items = items;
    }
  }

  // Recurse into a schema-form additionalProperties.
  if (isPlainObject(result.additionalProperties)) {
    result.additionalProperties = normalize(result.additionalProperties, depth + 1);
  }

  // Keep required[] limited to string keys.
  if (Array.isArray(result.required)) {
    result.required = (result.required as unknown[]).filter((r) => typeof r === "string");
  }

  return result;
}

/**
 * Normalize an OpenAI function `parameters` JSON Schema into the shape
 * GigaChat's function-calling validator accepts. Always returns a valid object
 * schema (`{ type: "object", properties: {} }` for empty/invalid input).
 */
export function normalizeGigaChatToolSchema(parameters: unknown): JsonRecord {
  if (!isPlainObject(parameters)) {
    return { type: "object", properties: {} };
  }
  const resolved = resolveRefs(parameters);
  const normalized = normalize(resolved);
  if (isPlainObject(normalized)) {
    if (typeof normalized.type !== "string") normalized.type = "object";
    ensureObjectProperties(normalized);
    return normalized;
  }
  return { type: "object", properties: {} };
}
