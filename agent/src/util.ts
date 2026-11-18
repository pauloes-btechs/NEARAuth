import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/* Shared browser/extension libraries, reused unchanged so the agent classifies and hashes exactly like the extension. */
export const Detection = require('../../extension/lib/detection.js') as {
  registrableDomain(host: string): string;
  parseSender(from: string): { name: string; address: string };
  classify(event: Record<string, unknown>, ctx: { account: Record<string, unknown>; history?: unknown[] }): ClassifyResult;
  PROCESSORS: string[];
};
export const Merkle = require('../../extension/lib/merkle.js') as {
  build(commitments: string[]): Promise<{ root: string; leafCount: number; proofs: { side: 'left' | 'right'; hash: string }[][] }>;
  verify(commitment: string, proof: { side: 'left' | 'right'; hash: string }[], root: string): Promise<boolean>;
};
export const Responder = require('../../extension/lib/responder.js') as {
  trustedAuthResult(r: { dkim: 'pass' | 'fail' | 'none'; dkimDomain?: string; signedHeaders?: string[]; verifier: string }): object;
  isTrustedAuth(x: unknown): boolean;
  checkUnsubscribeUrl(url: string, opts: { alignedDomain: string }): { ok: boolean; reason?: string; url?: string };
  plan(result: unknown, message: unknown, policy: unknown): { type: string; reason?: string; url?: string }[];
};

export interface ClassifyResult {
  classification: 'expected' | 'processor' | 'related' | 'unverified' | 'unexpected';
  confidence: 'none' | 'low' | 'medium' | 'high';
  summary: string;
  evidence: { signal: string; detail: string }[];
  recommendedActions: string[];
  senderDomain: string;
  accountDomain: string;
  authenticated: boolean;
}

export const newId = (prefix: string) => `${prefix}_${randomBytes(12).toString('base64url')}`;
export const newToken = () => randomBytes(32).toString('base64url');
export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const hmac = (key: Buffer, s: string) => createHmac('sha256', key).update(s).digest('hex');

export function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !/^[0-9a-f]*$/.test(a + b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/* Deterministic JSON: object keys sorted recursively, so hashes do not depend on property order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

/* c********x@simplelogin.com — enough to recognise, not enough to reuse. Used in logs, receipts and audit labels. */
export function maskAlias(email: string): string {
  const [local, domain] = String(email).split('@');
  if (!domain) return '***';
  if (local.length <= 2) return local[0] + '*@' + domain;
  return local[0] + '*'.repeat(Math.min(8, local.length - 2)) + local[local.length - 1] + '@' + domain;
}

/* Strips anything that looks like a credential before data is logged, stored in a receipt or checkpointed. */
const SECRET_KEYS = /(pass(word)?|secret|token|api[-_]?key|authorization|authentication|private[-_]?key|master|vault|cookie|session)/i;
export function sanitize<T>(value: T, depth = 0): T {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : sanitize(v, depth + 1);
  return out as T;
}

export class AgentError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); this.name = 'AgentError'; }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
