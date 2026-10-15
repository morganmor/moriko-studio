/**
 * Addon v2 manifest — types + validation (A2).
 *
 * apiVersion '2' → v2 module (activate/deactivate, contributions, permissions);
 * missing apiVersion → legacy v1 addon (register shim). Invalid manifests are
 * listed in the Hub with per-field errors and never loaded.
 */

export interface AddonManifestV2 {
  apiVersion: '2';
  id: string;
  name: string;
  shortName?: string;
  version: string;
  description: string;
  author?: string;
  kind?: 'feature' | 'tool-pack' | 'prompt-pack' | 'theme' | 'language' | 'mod';
  icon?: string;
  main?: string;
  client?: string;
  activation?: string[];
  dependencies?: Record<string, string>;
  conflicts?: string[];
  permissions?: string[];
  isolation?: 'in-process' | 'worker';
  contributes?: AddonContributes;
  [key: string]: unknown;
}

export interface AddonContributes {
  tools?: Array<{ name: string; readOnly?: boolean; category?: string; title?: string }>;
  commands?: Array<{ name: string; description: string; argumentHint?: string }>;
  views?: AddonViewContribution[];
  statusItems?: Array<{ id: string; alignment?: string }>;
  settings?: AddonSettingsSchema;
  promptFragments?: Array<{ id: string; order?: number; budgetChars?: number }>;
  toolRenderers?: Array<{ tool: string; component: string }>;
  events?: Array<{ name: string }>;
  themeTokens?: Record<string, Record<string, string>>;
  resources?: { i18n?: string; assets?: string; templates?: string };
}

export interface AddonViewContribution {
  id: string;
  title: string;
  icon?: string;
  /** sidebar (full page) | right-dock | hub | slot:<site> */
  location: 'sidebar' | 'right-dock' | 'hub' | `slot:${string}`;
  component: string;
  badge?: boolean;
}

export interface AddonSettingsSchema {
  title?: string;
  properties: Record<string, AddonSettingProperty>;
}

export interface AddonSettingProperty {
  type: 'string' | 'number' | 'boolean';
  enum?: Array<string | number>;
  default?: unknown;
  title?: string;
  description?: string;
  minimum?: number;
  maximum?: number;
  /** user = ~/.moriko-studio/addon-data/<id>/settings.json;
   *  workspace = <workspace>/.moriko/addons/<id>/settings.json */
  scope?: 'user' | 'workspace';
  requiresConsent?: boolean;
}

export interface ManifestValidation {
  ok: boolean;
  errors: string[];
  /** '2' = v2, '1' = legacy (no apiVersion), null = invalid. */
  apiVersion: '1' | '2' | null;
}

const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

export function validateManifest(raw: unknown): ManifestValidation {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['addon.json must be a JSON object'], apiVersion: null };
  }
  const m = raw as Record<string, unknown>;

  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) {
    errors.push(`id: must match ^[a-z][a-z0-9-]{1,31}$ (got ${JSON.stringify(m.id)})`);
  }
  if (typeof m.name !== 'string' || m.name.trim() === '') {
    errors.push('name: required non-empty string');
  }
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+/.test(m.version)) {
    errors.push(`version: must be semver-like (got ${JSON.stringify(m.version)})`);
  }
  if (typeof m.description !== 'string') {
    errors.push('description: required string');
  }

  const apiRaw = m.apiVersion;
  if (apiRaw === undefined) {
    // Legacy v1 — validated enough above; the rest is ignored.
    return { ok: errors.length === 0, errors, apiVersion: '1' };
  }
  if (apiRaw !== '2') {
    errors.push(`apiVersion: only "2" is supported (got ${JSON.stringify(apiRaw)})`);
    return { ok: false, errors, apiVersion: null };
  }

  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions) || m.permissions.some((p) => typeof p !== 'string')) {
      errors.push('permissions: must be an array of strings');
    }
  }
  if (m.dependencies !== undefined) {
    if (!m.dependencies || typeof m.dependencies !== 'object' || Array.isArray(m.dependencies)) {
      errors.push('dependencies: must be an object of {dependency: versionRange}');
    }
  }
  if (m.conflicts !== undefined) {
    if (!Array.isArray(m.conflicts) || m.conflicts.some((c) => typeof c !== 'string')) {
      errors.push('conflicts: must be an array of addon ids');
    }
  }
  if (m.activation !== undefined) {
    if (!Array.isArray(m.activation) || m.activation.some((a) => typeof a !== 'string')) {
      errors.push('activation: must be an array of activation hints');
    }
  }

  const contributes = m.contributes as AddonContributes | undefined;
  if (contributes && typeof contributes === 'object') {
    if (contributes.views !== undefined) {
      if (!Array.isArray(contributes.views)) {
        errors.push('contributes.views: must be an array');
      } else {
        for (const view of contributes.views) {
          if (!view || typeof view.id !== 'string' || typeof view.title !== 'string') {
            errors.push('contributes.views[]: id and title are required');
            break;
          }
          if (typeof view.component !== 'string') {
            errors.push(`contributes.views[${view.id}]: component is required`);
          }
          const loc = view.location;
          if (loc !== 'sidebar' && loc !== 'right-dock' && loc !== 'hub' && !(typeof loc === 'string' && loc.startsWith('slot:'))) {
            errors.push(`contributes.views[${view.id}]: location must be "sidebar" | "right-dock" | "hub" | "slot:<site>"`);
          }
        }
      }
    }
    if (contributes.settings !== undefined) {
      const s = contributes.settings;
      if (!s || typeof s !== 'object' || !s.properties || typeof s.properties !== 'object') {
        errors.push('contributes.settings: must be { title?, properties: {...} }');
      } else {
        for (const [key, prop] of Object.entries(s.properties)) {
          if (!prop || !['string', 'number', 'boolean'].includes(prop.type)) {
            errors.push(`contributes.settings.properties.${key}: type must be string|number|boolean`);
          }
        }
      }
    }
    if (contributes.themeTokens !== undefined) {
      const t = contributes.themeTokens;
      if (!t || typeof t !== 'object') {
        errors.push('contributes.themeTokens: must be an object of {theme: {token: value}}');
      } else {
        for (const [theme, tokens] of Object.entries(t)) {
          if (!['light', 'dark', 'mocha'].includes(theme)) {
            errors.push(`contributes.themeTokens: unknown theme "${theme}" (light|dark|mocha)`);
          }
          if (!tokens || typeof tokens !== 'object') continue;
          for (const name of Object.keys(tokens)) {
            if (!name.startsWith('--c-')) {
              errors.push(`contributes.themeTokens.${theme}: token "${name}" must start with --c-`);
            }
          }
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, apiVersion: '2' };
}

/** Parse a raw validated manifest into the typed v2 shape (after validateManifest ok). */
export function asManifestV2(raw: unknown): AddonManifestV2 {
  return raw as AddonManifestV2;
}
