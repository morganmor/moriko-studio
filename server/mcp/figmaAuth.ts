import { createServer, type Server } from 'node:http';
import { exec } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { atomicWriteJson } from '../atomicWrite.js';
import { figmaAuthFile } from '../paths.js';



const FIGMA_MCP_URL = 'https://mcp.figma.com/mcp';

export const FIGMA_DESKTOP_URL = 'http://127.0.0.1:3845/mcp';
const REDIRECT_PORT = 14515;
const SCOPES = ['file_read', 'file_dev_read', 'file_write'];

export interface FigmaTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  obtainedAt: string;
}

interface FigmaAuthStore {
  version: 1;
  tokens?: FigmaTokens;
  
  client?: { clientId: string; registrationAccessToken?: string };
}

let cache: FigmaAuthStore | null = null;

function load(): FigmaAuthStore {
  if (cache) return cache;
  try {
    if (existsSync(figmaAuthFile)) {
      cache = JSON.parse(readFileSync(figmaAuthFile, 'utf8')) as FigmaAuthStore;
      return cache;
    }
  } catch {
  }
  cache = { version: 1 };
  return cache;
}

function persist(next: FigmaAuthStore): void {
  cache = next;
  atomicWriteJson(figmaAuthFile, next);
}

export function figmaAuthStatus(): { connected: boolean; scope?: string; obtainedAt?: string } {
  const tokens = load().tokens;
  return { connected: !!tokens, scope: tokens?.scope, obtainedAt: tokens?.obtainedAt };
}

export function figmaAccessToken(): string | undefined {
  return load().tokens?.accessToken;
}


export function figmaAuthReset(): void {
  persist({ version: 1 });
}

function openBrowser(url: string): void {
  if (process.platform === 'win32') exec(`start "" "${url}"`);
  else if (process.platform === 'darwin') exec(`open "${url}"`);
  else exec(`xdg-open "${url}"`);
}

interface AuthMeta {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopes?: string[];
}

async function discoverAuth(): Promise<AuthMeta> {
  const resourceUrl = new URL(FIGMA_MCP_URL);
  const host = `${resourceUrl.protocol}//${resourceUrl.host}`;

  const resourceRes = await fetch(`${host}/.well-known/oauth-protected-resource`);
  if (!resourceRes.ok) throw new Error(`Figma OAuth discovery failed (HTTP ${resourceRes.status}).`);
  const resource = (await resourceRes.json()) as {
    authorization_servers?: string[];
    scopes_supported?: string[];
  };
  const issuer = resource.authorization_servers?.[0];
  if (!issuer) throw new Error('Figma OAuth discovery returned no authorization server.');

  const serverRes = await fetch(`${issuer}/.well-known/oauth-authorization-server`);
  if (!serverRes.ok) throw new Error(`Figma auth server metadata failed (HTTP ${serverRes.status}).`);
  const meta = (await serverRes.json()) as {
    authorization_endpoint?: string;
    token_endpoint?: string;
    registration_endpoint?: string;
    scopes_supported?: string[];
  };
  if (!meta.authorization_endpoint || !meta.token_endpoint) {
    throw new Error('Figma auth server metadata is missing endpoints.');
  }
  return {
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: meta.registration_endpoint,
    scopes: meta.scopes_supported ?? resource.scopes_supported ?? SCOPES,
  };
}

interface Registration {
  client_id: string;
  client_secret?: string;
  registration_access_token?: string;
}

async function registerClient(registrationEndpoint: string): Promise<Registration> {
  const stored = load().client;
  if (stored) return { client_id: stored.clientId, registration_access_token: stored.registrationAccessToken };

  const response = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Moriko Studio',
      redirect_uris: [`http://127.0.0.1:${REDIRECT_PORT}/callback`],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPES.join(' '),
    }),
  });
  if (!response.ok) {
    if (response.status === 403) {
      throw new Error(
        'Figma rejected this client: the remote MCP endpoint is restricted to clients listed in the Figma MCP Catalog ' +
        '(www.figma.com/mcp-catalog). Moriko must be added via Figma\'s catalog waitlist. ' +
        'Meanwhile, use the Figma desktop app: enable Dev Mode MCP Server, then add a LOCAL server ' +
        `pointing at ${FIGMA_DESKTOP_URL}.`,
      );
    }
    throw new Error(`Figma dynamic client registration failed (HTTP ${response.status}).`);
  }
  const registration = (await response.json()) as Registration;
  persist({
    ...load(),
    client: {
      clientId: registration.client_id,
      registrationAccessToken: registration.registration_access_token,
    },
  });
  return registration;
}


function waitForCode(): Promise<{ code: string; port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      const html = (title: string, body: string): void => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!doctype html><title>${title}</title><body style="font-family:sans-serif;text-align:center;padding-top:4rem"><h1>${title}</h1><p>${body}</p></body>`);
      };
      if (error) {
        html('Figma access denied', 'You may close this tab and retry from Moriko Settings.');
        reject(new Error(`Figma OAuth error: ${error}`));
        server.close();
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(400).end('Missing code');
        return;
      }
      html('Figma connected', 'You can close this tab and return to Moriko.');
      resolve({ code, port: REDIRECT_PORT, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
    server.on('error', reject);
    server.listen(REDIRECT_PORT, '127.0.0.1', () => undefined);
  });
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url');
}


export async function figmaSignIn(): Promise<{ ok: true }> {
  const meta = await discoverAuth();
  const registration = meta.registrationEndpoint
    ? await registerClient(meta.registrationEndpoint)
    : null;
  if (!registration) throw new Error('Figma auth server does not expose a registration endpoint.');

  const redirectUri = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  const state = base64Url(randomBytes(16));

  const wait = waitForCode();
  const authorizeUrl = new URL(meta.authorizationEndpoint);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', registration.client_id);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('scope', (meta.scopes ?? SCOPES).join(' '));
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  openBrowser(authorizeUrl.toString());

  const { code, close } = await wait;
  await close();

  const tokenRes = await fetch(meta.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: registration.client_id,
      code_verifier: verifier,
      state,
    }),
  });
  if (!tokenRes.ok) {
    const detail = await tokenRes.text().catch(() => '');
    throw new Error(`Figma token exchange failed (HTTP ${tokenRes.status}): ${detail.slice(0, 200)}`);
  }
  const token = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  persist({
    version: 1,
    client: load().client,
    tokens: {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
      scope: token.scope,
      obtainedAt: new Date().toISOString(),
    },
  });
  return { ok: true };
}


export async function figmaAuthorizationHeader(): Promise<Record<string, string>> {
  const store = load();
  const tokens = store.tokens;
  if (!tokens) throw new Error('Figma is not connected — press "Connect Figma" in Settings → MCP first.');

  const expired = tokens.expiresAt !== undefined && Date.now() > tokens.expiresAt - 60_000;
  if (expired && tokens.refreshToken) {
    const meta = await discoverAuth();
    const response = await fetch(meta.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
        client_id: store.client?.clientId ?? '',
      }),
    });
    if (response.ok) {
      const token = (await response.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
      };
      const fresh: FigmaTokens = {
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? tokens.refreshToken,
        expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
        scope: token.scope ?? tokens.scope,
        obtainedAt: new Date().toISOString(),
      };
      persist({ ...store, tokens: fresh });
      return { Authorization: `Bearer ${fresh.accessToken}` };
    }
  }
  return { Authorization: `Bearer ${tokens.accessToken}` };
}
