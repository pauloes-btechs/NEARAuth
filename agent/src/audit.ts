import type pg from 'pg';
import { randomBytes } from 'node:crypto';
import { Merkle, newId, sha256 } from './util.js';

/* Server-side audit events use the dashboard's commitment format — SHA-256 of "id|label|kind|ts|nonce" — so the
 * same Merkle tree code (extension/lib/merkle.js) can batch them. These are LOCAL commitments: nothing here is
 * written to NEAR, and the API never describes them as on-chain. */

export interface AuditEvent { id: string; kind: string; label: string; ts: string; nonce: string; commitment: string; thread_id: string | null }

export const commitmentOf = (e: { id: string; label: string; kind: string; ts: string; nonce: string }) =>
  sha256([e.id, e.label, e.kind, e.ts, e.nonce].join('|'));

export async function recordAudit(c: pg.PoolClient, userId: string, threadId: string | null, kind: string, label: string): Promise<AuditEvent> {
  const e = { id: newId('evt'), kind, label: label.slice(0, 300), ts: new Date().toISOString(), nonce: randomBytes(16).toString('hex') };
  const commitment = commitmentOf(e);
  await c.query('INSERT INTO audit_events(id, user_id, thread_id, kind, label, commitment, nonce, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [e.id, userId, threadId, e.kind, e.label, commitment, e.nonce, e.ts]);
  return { ...e, commitment, thread_id: threadId };
}

export async function auditBatch(c: pg.PoolClient, userId: string) {
  const rows = (await c.query('SELECT id, kind, label, created_at, nonce, commitment, thread_id FROM audit_events WHERE user_id = $1 ORDER BY created_at, id', [userId])).rows;
  const events = rows.map((r) => ({ id: r.id, kind: r.kind, label: r.label, ts: new Date(r.created_at).toISOString(), nonce: r.nonce, commitment: r.commitment, thread_id: r.thread_id }));
  const intact = events.map((e) => commitmentOf(e) === e.commitment);
  if (!events.length) return { root: null, leafCount: 0, events: [], anchored: false as const };
  const tree = await Merkle.build(events.map((e) => e.commitment));
  return {
    root: tree.root, leafCount: tree.leafCount, anchored: false as const,
    note: 'Local Merkle root of agent audit events. It is not on NEAR unless you anchor it from the dashboard.',
    events: events.map((e, i) => ({ ...e, intact: intact[i], proof: tree.proofs[i] })),
  };
}
