import { createRequire } from 'node:module';
import { ProviderError, TRANSIENT, type ProviderAdapter, type RemoteAlias, type RemoteSender } from './types.js';

const require = createRequire(import.meta.url);
const Providers = require('../../../extension/lib/alias-provider.js') as {
  SimpleLoginProvider(cfg: { token: string; baseUrl?: string; fetch?: typeof fetch }): {
    pause(id: string): Promise<void>; resume(id: string): Promise<void>;
    senders(id: string): Promise<{ id: number | string; address: string; blocked: boolean }[]>;
    blockSender(s: { id: number | string; blocked: boolean }): Promise<void>;
    unblockSender(s: { id: number | string; blocked: boolean }): Promise<void>;
  };
};

/**
 * Real SimpleLogin execution, reusing the extension's SimpleLoginProvider (same requests, same idempotent
 * read-then-toggle logic). The API key is held only in this closure: it is never returned, logged, put in graph
 * state, receipts or checkpoints. Every request has a timeout.
 */
export function createSimpleLoginAdapter(opts: { apiKey: string; baseUrl: string; timeoutMs?: number; fetchImpl?: typeof fetch }): ProviderAdapter {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const baseFetch = opts.fetchImpl ?? fetch;
  const timedFetch: typeof fetch = (url, init) => baseFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  const sl = Providers.SimpleLoginProvider({ token: opts.apiKey, baseUrl: opts.baseUrl, fetch: timedFetch });
  const base = opts.baseUrl.replace(/\/+$/, '');

  async function guard<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (e) {
      const err = e as Error & { code?: string; name: string };
      if (err instanceof ProviderError) throw err;
      if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new ProviderError('timeout', 'SimpleLogin did not answer in time', true);
      if (err.name === 'TypeError') throw new ProviderError('network', 'Could not reach SimpleLogin', true);
      const code = err.code || 'provider_error';
      throw new ProviderError(code, err.message, TRANSIENT.has(code)); // message never contains the key
    }
  }

  return {
    id: 'simplelogin',
    mode: 'real',
    label: 'SimpleLogin (real account — changes are applied to your aliases)',
    capabilities: { listSenders: true, blockSender: true, unblockSender: true, pauseAlias: true, resumeAlias: true, readBack: true, unsubscribe: false },
    getAlias: (remoteId) => guard(async (): Promise<RemoteAlias> => {
      const res = await timedFetch(`${base}/api/aliases/${encodeURIComponent(remoteId)}`, { headers: { Authentication: opts.apiKey, Accept: 'application/json' } });
      if (res.status === 404) throw new ProviderError('not_found', 'Alias not found at SimpleLogin');
      if (res.status === 401) throw new ProviderError('unauthorized', 'SimpleLogin rejected the API key');
      if (!res.ok) throw new ProviderError(`http_${res.status}`, `SimpleLogin returned HTTP ${res.status}`, TRANSIENT.has(`http_${res.status}`));
      const a = await res.json() as { id: number | string; email: string; enabled: boolean };
      return { remoteId: String(a.id), email: String(a.email).toLowerCase(), enabled: !!a.enabled };
    }),
    listSenders: (remoteId) => guard(async (): Promise<RemoteSender[]> =>
      (await sl.senders(remoteId)).map((s) => ({ remoteContactId: String(s.id), address: s.address, blocked: s.blocked }))),
    setSenderBlocked: (remoteId, contactId, blocked) => guard(async () => {
      const s = (await sl.senders(remoteId)).find((x) => String(x.id) === contactId);
      if (!s) throw new ProviderError('not_found', 'Sender not found at SimpleLogin');
      if (s.blocked === blocked) return;
      await (blocked ? sl.blockSender(s) : sl.unblockSender(s));
    }),
    setAliasEnabled: (remoteId, enabled) => guard(() => (enabled ? sl.resume(remoteId) : sl.pause(remoteId))),
  };
}
