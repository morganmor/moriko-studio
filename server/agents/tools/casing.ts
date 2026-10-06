/**
 * CASE TRANSLATION — single source of truth for the casing boundary between
 * the wire layer (JSON Schema presented to the model → snake_case) and engine
 * internals (camelCase, TS idiom).
 *
 *   snakeToCamel  inbound : max_results  → maxResults   (what tools read)
 *   camelToSnake  outbound: maxResults  → max_results   (what the model sees)
 *   toWireSchema  deep-copies a schema, snake-casing property / required / item keys
 *   camelizeSchemaNode deep-copies a schema, camel-casing those same keys (validation side)
 *
 * Both direction functions are idempotent on already-canonical input, so they
 * can run at a boundary without knowing which casing the caller sent.
 */

/** `max_results` → `maxResults`. No-op on already-camelCase keys. */
export function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_m, ch: string) => ch.toUpperCase());
}

/** `maxResults` → `max_results`. No-op on already-snake_case keys. */
export function camelToSnake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** Deep-copy a schema node, snake-casing property / required / items keys. */
export function toWireSchema(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...node };
  const props = node.properties as Record<string, unknown> | undefined;
  if (props && typeof props === 'object') {
    const snake: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      snake[camelToSnake(k)] = toWireSchema(v as Record<string, unknown>);
    }
    out.properties = snake;
  }
  if (Array.isArray(node.required)) {
    out.required = node.required.map((r) => camelToSnake(String(r)));
  }
  const items = node.items as Record<string, unknown> | undefined;
  if (items && typeof items === 'object') out.items = toWireSchema(items);
  return out;
}

/** Deep-copy a schema node, camel-casing property / required / items keys. */
export function camelizeSchemaNode(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...node };
  const props = node.properties as Record<string, unknown> | undefined;
  if (props && typeof props === 'object') {
    const camel: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      camel[snakeToCamel(k)] = camelizeSchemaNode(v as Record<string, unknown>);
    }
    out.properties = camel;
  }
  if (Array.isArray(node.required)) {
    out.required = node.required.map((r) => snakeToCamel(String(r)));
  }
  const items = node.items as Record<string, unknown> | undefined;
  if (items && typeof items === 'object') out.items = camelizeSchemaNode(items);
  return out;
}