


export function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_m, ch: string) => ch.toUpperCase());
}


export function camelToSnake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}


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