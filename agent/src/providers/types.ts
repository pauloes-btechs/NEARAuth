/* Provider adapter contract. Graph nodes depend on this interface only, so a new alias service is one new file.
 * Every write is "set to a desired state", never "flip": adapters read current state first, which makes retries
 * and crash recovery safe even when the underlying API only offers a toggle (SimpleLogin). */

export type ProviderId = 'mock' | 'simplelogin';
export type ExecutionMode = 'simulation' | 'real';

export interface ProviderCapabilities {
  listSenders: boolean;
  blockSender: boolean;
  unblockSender: boolean;
  pauseAlias: boolean;
  resumeAlias: boolean;
  readBack: boolean;        // can the adapter re-read authoritative state to verify a write?
  unsubscribe: boolean;     // needs verified inbound headers; no current provider exposes them
}

export interface RemoteAlias { remoteId: string; email: string; enabled: boolean }
export interface RemoteSender { remoteContactId: string; address: string; blocked: boolean }

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly mode: ExecutionMode;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;
  getAlias(remoteId: string): Promise<RemoteAlias>;
  listSenders(remoteId: string): Promise<RemoteSender[]>;
  setSenderBlocked(remoteId: string, remoteContactId: string, blocked: boolean): Promise<void>;
  setAliasEnabled(remoteId: string, enabled: boolean): Promise<void>;
}

export class ProviderError extends Error {
  constructor(public code: string, message: string, public transient = false) { super(message); this.name = 'ProviderError'; }
}

export const TRANSIENT = new Set(['rate_limited', 'timeout', 'network', 'http_500', 'http_502', 'http_503', 'http_504']);
