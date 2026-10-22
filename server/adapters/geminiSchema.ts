/**
 * JSON Schema → Gemini `FunctionDeclaration` translation.
 *
 * Gemini's `Schema` proto is a CLOSED set of fields (verified against
 * generativelanguage.googleapis.com/$discovery/rest?version=v1beta):
 *   type, format, title, description, nullable, default, items, minItems,
 *   maxItems, minProperties, maxProperties, minimum, maximum, minLength,
 *   maxLength, pattern, enum, properties, required, propertyOrdering,
 *   example, anyOf
 *
 * Anything else in a tool's `inputSchema` (`additionalProperties`, `oneOf`,
 * `$ref`, `$schema`, `const`, `examples`, …) makes protobuf parsing fail and
 * Gemini rejects the ENTIRE request with HTTP 400 — one addon tool is enough
 * to break every generation.
 *
 * Two paths out:
 *  1. `parametersJsonSchema` (preferred) — takes real JSON Schema verbatim,
 *     so nothing is lost. Google's own docs use `additionalProperties` there.
 *  2. `parameters` + {@link toGeminiSchema} — lossy but universally supported
 *     fallback for API surfaces that predate `parametersJsonSchema`.
 */

/** Fields the Gemini `Schema` proto actually has. */
const ALLOWED = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'default',
  'items',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'enum',
  'properties',
  'required',
  'propertyOrdering',
  'example',
  'anyOf',
]);

/** JSON Schema type names → Gemini `Type` enum member names. */
const TYPE_MAP: Record<string, string> = {
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
  object: 'OBJECT',
  null: 'NULL',
};

/** Tool names Gemini accepts: a-z A-Z 0-9 _ - , max 128 chars. */
const WIRE_NAME = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Gemini rejects the whole request over one malformed declaration name, so
 * MCP tools with dots/slashes are folded onto the allowed alphabet instead.
 */
export function geminiToolName(name: string): string {
  if (WIRE_NAME.test(name)) return name;
  const folded = name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
  return folded || 'tool';
}

export function isGeminiSafeToolName(name: string): boolean {
  return WIRE_NAME.test(name);
}

type JsonSchema = Record<string, unknown>;

/** Resolves a local `$ref` against the schema's own `$defs`/`definitions`. */
function resolveRef(ref: string, root: JsonSchema, depth: number): JsonSchema | null {
  if (depth > 8 || !ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  let node: unknown = root;
  for (const raw of parts) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!node || typeof node !== 'object') return null;
    node = (node as JsonSchema)[key];
  }
  return node && typeof node === 'object' ? (node as JsonSchema) : null;
}

/** `oneOf` is not in the proto; `anyOf` is the honest nearest equivalent. */
function alternatives(node: JsonSchema): unknown[] | null {
  const list = node.anyOf ?? node.oneOf ?? node.allOf;
  return Array.isArray(list) ? list : null;
}

/**
 * Converts one JSON Schema node into a Gemini `Schema` object.
 * Lossy by design — the caller only reaches this path when the API refused
 * the lossless `parametersJsonSchema` field.
 */
export function toGeminiSchema(node: unknown, root?: JsonSchema, depth = 0): JsonSchema | null {
  if (!node || typeof node !== 'object' || depth > 16) return null;
  const schema = node as JsonSchema;
  const base = root ?? schema;

  if (typeof schema.$ref === 'string') {
    const target = resolveRef(schema.$ref, base, depth);
    if (!target) return { type: 'STRING', description: schema.description as string | undefined };
    return toGeminiSchema({ ...target, description: schema.description ?? target.description }, base, depth + 1);
  }

  const out: JsonSchema = {};

  for (const key of ALLOWED) {
    if (key === 'properties' || key === 'items' || key === 'anyOf' || key === 'type') continue;
    if (key === 'required') continue;
    const value = schema[key];
    if (value !== undefined) out[key] = value;
  }

  // `const: x` has no proto equivalent; a single-value enum says the same thing.
  if (schema.const !== undefined && out.enum === undefined) out.enum = [schema.const];

  // Union types: the proto takes ONE type; `null` becomes `nullable`.
  const rawType = schema.type;
  let typeName: string | undefined;
  if (Array.isArray(rawType)) {
    const members = rawType.filter((entry): entry is string => typeof entry === 'string');
    if (members.includes('null') && members.length > 1) out.nullable = true;
    typeName = members.find((entry) => entry !== 'null');
  } else if (typeof rawType === 'string') {
    typeName = rawType;
  }

  const alts = alternatives(schema);
  if (alts) {
    const converted = alts.map((entry) => toGeminiSchema(entry, base, depth + 1)).filter(Boolean);
    if (converted.length > 0) out.anyOf = converted;
  }

  const props = schema.properties;
  if (props && typeof props === 'object') {
    const converted: JsonSchema = {};
    for (const [name, child] of Object.entries(props as JsonSchema)) {
      const childSchema = toGeminiSchema(child, base, depth + 1);
      if (childSchema) converted[name] = childSchema;
    }
    out.properties = converted;
    // Preserving declaration order keeps the model's argument order stable.
    out.propertyOrdering = Object.keys(converted);

    const required = schema.required;
    if (Array.isArray(required)) {
      const kept = required.filter((name): name is string => typeof name === 'string' && name in converted);
      if (kept.length > 0) out.required = kept;
    }
    typeName ??= 'object';
  }

  if (schema.items !== undefined) {
    const items = Array.isArray(schema.items) ? schema.items[0] : schema.items;
    const converted = toGeminiSchema(items, base, depth + 1);
    if (converted) out.items = converted;
    typeName ??= 'array';
  }

  // Without an explicit type Gemini infers nothing; object/array are safe.
  const mapped = typeName ? TYPE_MAP[typeName.toLowerCase()] : undefined;
  if (mapped) out.type = mapped;

  return Object.keys(out).length > 0 ? out : { type: 'STRING' };
}

/** A function declaration for the lossless `parametersJsonSchema` path. */
export function toGeminiDeclaration(tool: {
  wireName: string;
  description?: string | null;
  inputSchema?: unknown;
}): Record<string, unknown> {
  const schema = (tool.inputSchema ?? { type: 'object', properties: {} }) as JsonSchema;
  return {
    name: geminiToolName(tool.wireName),
    description: tool.description ?? '',
    parametersJsonSchema: schema,
  };
}

/** A function declaration for the lossy `parameters` fallback path. */
export function toGeminiDeclarationLegacy(tool: {
  wireName: string;
  description?: string | null;
  inputSchema?: unknown;
}): Record<string, unknown> {
  const schema = (tool.inputSchema ?? { type: 'object', properties: {} }) as JsonSchema;
  return {
    name: geminiToolName(tool.wireName),
    description: tool.description ?? '',
    parameters: toGeminiSchema(schema) ?? { type: 'OBJECT', properties: {} },
  };
}
