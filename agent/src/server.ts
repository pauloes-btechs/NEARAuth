import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { loadConfig, type AgentConfig } from './config.js';
import { AgentService, type Session } from './service.js';
import { AgentError } from './util.js';

/* Minimal JSON API. No cookies: the bearer token travels in the Authorization header, and only allow-listed
 * origins get CORS headers, so other sites cannot drive the API from a user's browser. Errors never echo input. */

const MAX_BODY = 64 * 1024;

type Handler = (ctx: { s: Session; token: string; body: unknown; params: string[]; query: URLSearchParams }) => Promise<unknown>;
interface Route { method: string; pattern: RegExp; auth: boolean; handler: Handler | ((ctx: { query: URLSearchParams }) => Promise<unknown>) }

export function createApi(svc: AgentService, cfg: AgentConfig) {
  const routes: Route[] = [];
  const add = (method: string, path: string, handler: Handler, auth = true) =>
    routes.push({ method, pattern: new RegExp('^' + path.replace(/:[a-z]+/g, '([A-Za-z0-9_-]{3,80})') + '$'), auth, handler });

  const health = async () => ({
    ok: true, provider: { id: svc.provider.id, mode: svc.provider.mode, label: svc.provider.label }, database: svc.db.kind,
    model: svc.intentModelName ?? 'off (deterministic rules)', embedder: svc.memory.model,
  });
  routes.push({ method: 'GET', pattern: /^\/v1\/health$/, auth: false, handler: health });
  routes.push({ method: 'GET', pattern: /^\/v1\/graph$/, auth: false, handler: async () => svc.describe() });

  add('GET', '/v1/me', async ({ s }) => ({ ...(await svc.settings(s)), deviceId: s.deviceId, sessionAuthenticatedAt: s.authenticatedAt }));
  add('POST', '/v1/session/revoke', async ({ s, token }) => { await svc.revoke(s, token); return { revoked: true }; });
  add('GET', '/v1/aliases', async ({ s }) => svc.listAliases(s));
  add('POST', '/v1/sync', async ({ s, body }) => svc.sync(s, body));
  add('POST', '/v1/workflows', async ({ s, body }) => svc.start(s, body as never));
  add('GET', '/v1/workflows', async ({ s }) => svc.listWorkflows(s));
  add('GET', '/v1/workflows/:id', async ({ s, params }) => svc.snapshot(s, params[0]));
  add('POST', '/v1/workflows/:id/decision', async ({ s, params, body }) => svc.decide(s, params[0], body as never));
  add('POST', '/v1/workflows/:id/target', async ({ s, params, body }) => svc.selectTarget(s, params[0], body as never));
  add('POST', '/v1/workflows/:id/cancel', async ({ s, params }) => svc.cancel(s, params[0]));
  add('POST', '/v1/workflows/:id/recover', async ({ s, params }) => svc.recover(s, params[0]));
  add('GET', '/v1/approvals', async ({ s }) => svc.pendingApprovals(s));
  add('GET', '/v1/history', async ({ s }) => svc.history(s));
  add('POST', '/v1/receipts/:id/undo', async ({ s, params }) => svc.undo(s, params[0]));
  add('GET', '/v1/policies', async ({ s }) => svc.listPolicies(s));
  add('POST', '/v1/policies', async ({ s, body }) => svc.addPolicy(s, body));
  add('DELETE', '/v1/policies/:id', async ({ s, params }) => svc.removePolicy(s, params[0]));
  add('GET', '/v1/memory', async ({ s }) => svc.memory.list(s.userId));
  add('POST', '/v1/memory', async ({ s, body }) => {
    const text = String((body as { text?: unknown })?.text ?? '').trim();
    if (!text) throw new AgentError('empty', 'Nothing to remember', 400);
    const st = await svc.settings(s);
    return { id: await svc.memory.remember(s.userId, text, st.memoryOptOut) };
  });
  add('DELETE', '/v1/memory/:id', async ({ s, params }) => ({ removed: await svc.memory.remove(s.userId, params[0]) }));
  add('DELETE', '/v1/memory', async ({ s }) => ({ removed: await svc.memory.clear(s.userId) }));
  add('GET', '/v1/settings', async ({ s }) => svc.settings(s));
  add('PATCH', '/v1/settings', async ({ s, body }) => svc.updateSettings(s, body));
  add('DELETE', '/v1/history', async ({ s }) => svc.deleteHistory(s));
  add('GET', '/v1/audit', async ({ s }) => svc.audit(s));

  function send(res: ServerResponse, status: number, body: unknown, origin: string | null) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    };
    if (origin) { headers['Access-Control-Allow-Origin'] = origin; headers.Vary = 'Origin'; }
    res.writeHead(status, headers);
    res.end(status === 204 ? undefined : JSON.stringify(body));
  }

  async function readBody(req: IncomingMessage): Promise<unknown> {
    if (req.method === 'GET' || req.method === 'DELETE') return undefined;
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new AgentError('unsupported_media', 'Send application/json', 415);
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) { size += (chunk as Buffer).length; if (size > MAX_BODY) throw new AgentError('too_large', 'Request body too large', 413); chunks.push(chunk as Buffer); }
    if (!size) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AgentError('bad_json', 'Body is not valid JSON', 400); }
  }

  return createServer(async (req, res) => {
    const origin = req.headers.origin ?? null;
    const allowed = origin && cfg.allowedOrigins.includes(origin) ? origin : null;
    try {
      if (origin && !allowed) throw new AgentError('origin_forbidden', 'Origin not allowed', 403);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': allowed ?? '', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE', Vary: 'Origin',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' });
        return res.end();
      }
      const url = new URL(req.url ?? '/', 'http://agent.local');
      const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!route) throw new AgentError('not_found', 'No such endpoint', 404);
      const params = url.pathname.match(route.pattern)!.slice(1);
      if (!route.auth) return send(res, 200, await (route.handler as (c: { query: URLSearchParams }) => Promise<unknown>)({ query: url.searchParams }), allowed);
      const token = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
      const s = await svc.authenticate(token);
      const body = await readBody(req);
      send(res, 200, await (route.handler as Handler)({ s, token: token!, body, params, query: url.searchParams }), allowed);
    } catch (e) {
      if (e instanceof AgentError) return send(res, e.status, { error: e.code, message: e.message }, allowed);
      if (e instanceof ZodError) return send(res, 400, { error: 'invalid_request', message: e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') }, allowed);
      console.error('[agent] unexpected error:', (e as Error).message);
      send(res, 500, { error: 'internal', message: 'Something went wrong; nothing was changed unless a receipt says so.' }, allowed);
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cfg = loadConfig();
  const svc = await AgentService.create({ config: cfg });
  if (process.env.NEARAUTH_SEED_DEMO === '1') await svc.seedDemo('demo');
  const server = createApi(svc, cfg);
  server.listen(cfg.port, cfg.host, () => {
    console.log(`NEARAuth agent listening on http://${cfg.host}:${cfg.port}`);
    console.log(`  provider: ${svc.provider.label}`);
    console.log(`  database: ${svc.db.kind}${svc.db.kind === 'pglite' ? ` (embedded, data in ${cfg.dataDir}/pglite)` : ''}`);
    console.log(`  model:    ${svc.intentModelName ?? 'off — deterministic rules only'}`);
    console.log(`  origins:  ${cfg.allowedOrigins.join(', ')}`);
  });
  const stop = async () => { server.close(); await svc.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
