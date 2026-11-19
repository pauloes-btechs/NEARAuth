import { ProviderError, type ProviderAdapter, type RemoteAlias, type RemoteSender } from './types.js';

interface MockAlias { email: string; enabled: boolean; contacts: { id: string; address: string; blocked: boolean }[] }

/**
 * In-memory stand-in for an alias service, with SimpleLogin's semantics (toggle endpoints underneath).
 * Used for the simulation mode and all automated tests. Supports fault injection.
 */
export class MockProvider implements ProviderAdapter {
  readonly id = 'mock' as const;
  readonly mode = 'simulation' as const;
  readonly label = 'Mock provider (simulation — nothing leaves this machine)';
  readonly capabilities = { listSenders: true, blockSender: true, unblockSender: true, pauseAlias: true, resumeAlias: true, readBack: true, unsubscribe: false };

  aliases = new Map<string, MockAlias>();
  calls: string[] = [];
  offline = false;
  private failures: { code: string; transient: boolean }[] = [];
  /** Called after a write is applied but before it returns — lets tests simulate a crash mid-execution. */
  afterWrite: (() => void) | null = null;

  addAlias(remoteId: string, email: string, enabled = true) {
    if (!this.aliases.has(remoteId)) this.aliases.set(remoteId, { email, enabled, contacts: [] });
    return this;
  }
  addSender(remoteId: string, contactId: string, address: string, blocked = false) {
    const a = this.aliases.get(remoteId);
    if (!a) throw new Error('unknown mock alias ' + remoteId);
    if (!a.contacts.some((c) => c.id === contactId)) a.contacts.push({ id: contactId, address: address.toLowerCase(), blocked });
    return this;
  }
  failNext(code: string, times = 1, transient = true) { for (let i = 0; i < times; i++) this.failures.push({ code, transient }); }

  private gate(op: string) {
    this.calls.push(op);
    if (this.offline) throw new ProviderError('network', 'Mock provider is offline', true);
    const f = this.failures.shift();
    if (f) throw new ProviderError(f.code, `Mock provider failure: ${f.code}`, f.transient);
  }
  private alias(remoteId: string) {
    const a = this.aliases.get(remoteId);
    if (!a) throw new ProviderError('not_found', 'Alias not found at provider', false);
    return a;
  }

  async getAlias(remoteId: string): Promise<RemoteAlias> {
    this.gate(`GET alias ${remoteId}`);
    const a = this.alias(remoteId);
    return { remoteId, email: a.email, enabled: a.enabled };
  }
  async listSenders(remoteId: string): Promise<RemoteSender[]> {
    this.gate(`GET senders ${remoteId}`);
    return this.alias(remoteId).contacts.map((c) => ({ remoteContactId: c.id, address: c.address, blocked: c.blocked }));
  }
  async setSenderBlocked(remoteId: string, contactId: string, blocked: boolean) {
    this.gate(`SET sender ${remoteId}/${contactId} blocked=${blocked}`);
    const c = this.alias(remoteId).contacts.find((x) => x.id === contactId);
    if (!c) throw new ProviderError('not_found', 'Sender not found at provider', false);
    if (c.blocked !== blocked) c.blocked = !c.blocked; // toggle, like SimpleLogin
    this.afterWrite?.();
  }
  async setAliasEnabled(remoteId: string, enabled: boolean) {
    this.gate(`SET alias ${remoteId} enabled=${enabled}`);
    const a = this.alias(remoteId);
    if (a.enabled !== enabled) a.enabled = !a.enabled;
    this.afterWrite?.();
  }
  writes() { return this.calls.filter((c) => c.startsWith('SET')); }
}
