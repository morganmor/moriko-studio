


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


const TYPE_MAP: Record<string, string> = {
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
  object: 'OBJECT',
  null: 'NULL',
};


const WIRE_NAME = /^[A-Za-z0-9_-]{1,128}$/;


export function geminiToolName(name: string): string {
  if (WIRE_NAME.test(name)) return name;
  const folded = name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
  return folded || 'tool';
}

export function isGeminiSafeToolName(name: string): boolean {
  return WIRE_NAME.test(name);
}

type JsonSchema = Record<string, unknown>;


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


function alternatives(node: JsonSchema): unknown[] | null {
  const list = node.anyOf ?? node.oneOf ?? node.allOf;
  return Array.isArray(list) ? list : null;
}


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

  if (schema.const !== undefined && out.enum === undefined) out.enum = [schema.const];

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

  const mapped = typeName ? TYPE_MAP[typeName.toLowerCase()] : undefined;
  if (mapped) out.type = mapped;

  return Object.keys(out).length > 0 ? out : { type: 'STRING' };
}


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
