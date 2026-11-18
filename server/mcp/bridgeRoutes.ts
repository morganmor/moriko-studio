

import { Router, type Request, type Response } from 'express';
import { bridgeToken, bridgeToolDefs, callBridgeTool, bridgeSettings, patchBridgeConfig } from './bridge.js';


const sessions = new Set<string>();
let sessionCounter = 0;

function jsonError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', id: null, error: { code, message } });
}

export function bridgeRouter(): Router {
  const router = Router();

  
  router.get('/mcp', (_req, res) => {
    res.status(200).json({ server: 'moriko-mcp-bridge', transport: 'streamable-http', auth: 'token-in-path' });
  });

  router.post('/mcp/:token', (req: Request, res: Response) => {
    const token = bridgeToken();
    const presented = [
      req.params.token,
      String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim(),
      String(req.headers['x-moriko-token'] ?? '').trim(),
    ].filter(Boolean);
    if (!presented.includes(token)) {
      return jsonError(res, 401, -32001, 'Unauthorized: invalid bridge token.');
    }

    const body = req.body as
      | { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> }
      | undefined;
    if (!body || typeof body.method !== 'string') {
      return jsonError(res, 400, -32600, 'Invalid JSON-RPC request.');
    }
    const isNotification = body.id === undefined || body.id === null;

    const reply = (result: unknown): void => {
      if (isNotification) return void res.status(202).end();
      res.json({ jsonrpc: '2.0', id: body.id, result });
    };

    switch (body.method) {
      case 'initialize': {
        const sid = `bridge-${++sessionCounter}-${Date.now()}`;
        sessions.add(sid);
        return void res
          .header('Mcp-Session-Id', sid)
          .json({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: String(body.params?.protocolVersion ?? '2025-06-18'),
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'moriko-mcp-bridge', version: '1.0.0' },
            },
          });
      }
      case 'notifications/initialized':
        return void res.status(202).end();
      case 'tools/list':
        return reply({ tools: bridgeToolDefs() });
      case 'tools/call': {
        const name = String(body.params?.name ?? '');
        const args = (body.params?.arguments as Record<string, unknown> | undefined) ?? {};
        void callBridgeTool(name, args)
          .then((result) => reply(result))
          .catch((error: unknown) => {
            res.status(200).json({
              jsonrpc: '2.0',
              id: body.id,
              result: { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true },
            });
          });
        return;
      }
      case 'ping':
        return reply({});
      default:
        return jsonError(res, 404, -32601, `Method not supported: ${body.method}`);
    }
  });

  router.post('/mcp', (_req, res) => jsonError(res, 401, -32001, 'Unauthorized: invalid bridge token.'));

  router.get('/api/mcp-bridge', (_req, res) => {
    res.json(bridgeSettings());
  });

  router.post('/api/mcp-bridge', (req, res) => {
    const patch = req.body as { sessionId?: unknown; workspaceId?: unknown };
    patchBridgeConfig({
      sessionId: typeof patch?.sessionId === 'string' ? patch.sessionId : undefined,
      workspaceId: typeof patch?.workspaceId === 'string' ? patch.workspaceId : undefined,
    });
    res.json(bridgeSettings());
  });

  return router;
}
