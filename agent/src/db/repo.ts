import type pg from 'pg';
import { newId } from '../util.js';

/* Typed data access. Every function takes a client that is already inside withUser(...), so row-level security
 * scopes every statement to the authenticated user; the explicit user_id predicates are a second layer. */

export interface UserRow { id: string; display_name: string; agent_enabled: boolean; memory_opt_out: boolean; retention_days: number }
export interface AliasRow {
  id: string; user_id: string; alias_email: string; service_name: string; service_domain: string;
  provider_id: string; remote_id: string | null; enabled: boolean; created_at: Date; last_activity_at: Date | null; credential_status: string;
}
export interface SenderRow {
  id: string; user_id: string; alias_id: string; sender_address: string; sender_domain: string; sender_display_name: string | null;
  remote_contact_id: string | null; blocked: boolean; classification: string | null; confidence: string | null; observed_at: Date;
}
export interface WorkflowRow {
  thread_id: string; user_id: string; device_id: string; request_text: string; intent: string | null; status: string;
  mode: string; path: string[]; summary: string | null; created_at: Date; updated_at: Date;
}
export interface ProposalRow {
  id: string; user_id: string; thread_id: string; action: string; alias_id: string | null; sender_id: string | null;
  provider_id: string; risk_tier: string; reversible: boolean; action_hash: string; explanation: Record<string, unknown>; created_at: Date;
}
export interface ReceiptRow {
  id: string; user_id: string; thread_id: string; proposal_id: string | null; idempotency_key: string; tool: string; mode: string;
  status: string; attempts: number; sanitized_input: Record<string, unknown>; sanitized_output: Record<string, unknown> | null;
  error_code: string | null; commitment: string | null; created_at: Date; updated_at: Date;
}
export interface PolicyRow {
  id: string; user_id: string; kind: 'always_require_approval' | 'auto_approve'; action: string; alias_id: string | null;
  sender_domain: string | null; expires_at: Date | null; created_at: Date;
}

type C = pg.PoolClient;
const one = async <T>(c: C, sql: string, args: unknown[]): Promise<T | null> => ((await c.query(sql, args)).rows[0] as T) ?? null;
const many = async <T>(c: C, sql: string, args: unknown[]): Promise<T[]> => (await c.query(sql, args)).rows as T[];

export const users = {
  get: (c: C, id: string) => one<UserRow>(c, 'SELECT * FROM agent_users WHERE id = $1', [id]),
  ensure: (c: C, id: string, name: string) =>
    c.query('INSERT INTO agent_users(id, display_name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [id, name]),
  update: (c: C, id: string, patch: Partial<Pick<UserRow, 'agent_enabled' | 'memory_opt_out' | 'retention_days'>>) =>
    one<UserRow>(c, `UPDATE agent_users SET agent_enabled = COALESCE($2, agent_enabled), memory_opt_out = COALESCE($3, memory_opt_out),
      retention_days = COALESCE($4, retention_days) WHERE id = $1 RETURNING *`, [id, patch.agent_enabled ?? null, patch.memory_opt_out ?? null, patch.retention_days ?? null]),
};

export const aliases = {
  list: (c: C, userId: string) => many<AliasRow>(c, 'SELECT * FROM user_aliases WHERE user_id = $1 ORDER BY service_name, alias_email', [userId]),
  get: (c: C, userId: string, id: string) => one<AliasRow>(c, 'SELECT * FROM user_aliases WHERE user_id = $1 AND id = $2', [userId, id]),
  byEmail: (c: C, userId: string, email: string) => one<AliasRow>(c, 'SELECT * FROM user_aliases WHERE user_id = $1 AND lower(alias_email) = lower($2)', [userId, email]),
  upsert: (c: C, a: Omit<AliasRow, 'created_at' | 'last_activity_at' | 'enabled'> & { enabled?: boolean; last_activity_at?: Date | null; created_at?: Date }) =>
    one<AliasRow>(c, `INSERT INTO user_aliases(id, user_id, alias_email, service_name, service_domain, provider_id, remote_id, enabled, credential_status, last_activity_at, created_at)
      VALUES ($1,$2,lower($3),$4,lower($5),$6,$7,COALESCE($8,true),$9,$10,COALESCE($11, now()))
      ON CONFLICT (user_id, alias_email) DO UPDATE SET service_name = EXCLUDED.service_name, service_domain = EXCLUDED.service_domain,
        provider_id = EXCLUDED.provider_id, remote_id = EXCLUDED.remote_id, credential_status = EXCLUDED.credential_status,
        last_activity_at = COALESCE(EXCLUDED.last_activity_at, user_aliases.last_activity_at)
      RETURNING *`,
      [a.id, a.user_id, a.alias_email, a.service_name, a.service_domain, a.provider_id, a.remote_id, a.enabled ?? null, a.credential_status, a.last_activity_at ?? null, a.created_at ?? null]),
  setEnabled: (c: C, userId: string, id: string, enabled: boolean) => c.query('UPDATE user_aliases SET enabled = $3 WHERE user_id = $1 AND id = $2', [userId, id, enabled]),
};

export const senders = {
  forAlias: (c: C, userId: string, aliasId: string) =>
    many<SenderRow>(c, 'SELECT * FROM sender_observations WHERE user_id = $1 AND alias_id = $2 ORDER BY observed_at', [userId, aliasId]),
  all: (c: C, userId: string) => many<SenderRow>(c, 'SELECT * FROM sender_observations WHERE user_id = $1 ORDER BY observed_at DESC', [userId]),
  get: (c: C, userId: string, id: string) => one<SenderRow>(c, 'SELECT * FROM sender_observations WHERE user_id = $1 AND id = $2', [userId, id]),
  upsert: (c: C, s: Omit<SenderRow, 'observed_at' | 'id'> & { id?: string; observed_at?: Date }) =>
    one<SenderRow>(c, `INSERT INTO sender_observations(id, user_id, alias_id, sender_address, sender_domain, sender_display_name, remote_contact_id, blocked, classification, confidence, observed_at)
      VALUES ($1,$2,$3,lower($4),lower($5),$6,$7,$8,$9,$10,COALESCE($11, now()))
      ON CONFLICT (alias_id, sender_address) DO UPDATE SET remote_contact_id = COALESCE(EXCLUDED.remote_contact_id, sender_observations.remote_contact_id),
        blocked = EXCLUDED.blocked, classification = EXCLUDED.classification, confidence = EXCLUDED.confidence,
        sender_display_name = COALESCE(EXCLUDED.sender_display_name, sender_observations.sender_display_name)
      RETURNING *`,
      [s.id ?? newId('snd'), s.user_id, s.alias_id, s.sender_address, s.sender_domain, s.sender_display_name, s.remote_contact_id, s.blocked, s.classification, s.confidence, s.observed_at ?? null]),
  setBlocked: (c: C, userId: string, id: string, blocked: boolean) =>
    c.query('UPDATE sender_observations SET blocked = $3 WHERE user_id = $1 AND id = $2', [userId, id, blocked]),
};

export const workflows = {
  insert: (c: C, w: Pick<WorkflowRow, 'thread_id' | 'user_id' | 'device_id' | 'request_text' | 'mode'>) =>
    c.query(`INSERT INTO privacy_workflows(thread_id, user_id, device_id, request_text, status, mode) VALUES ($1,$2,$3,$4,'planned',$5)`,
      [w.thread_id, w.user_id, w.device_id, w.request_text, w.mode]),
  update: (c: C, userId: string, threadId: string, patch: { status?: string; intent?: string | null; path?: string[]; summary?: string | null }) =>
    c.query(`UPDATE privacy_workflows SET status = COALESCE($3, status), intent = COALESCE($4, intent), path = COALESCE($5::jsonb, path),
      summary = COALESCE($6, summary), updated_at = now() WHERE user_id = $1 AND thread_id = $2`,
      [userId, threadId, patch.status ?? null, patch.intent ?? null, patch.path ? JSON.stringify(patch.path) : null, patch.summary ?? null]),
  get: (c: C, userId: string, threadId: string) => one<WorkflowRow>(c, 'SELECT * FROM privacy_workflows WHERE user_id = $1 AND thread_id = $2', [userId, threadId]),
  list: (c: C, userId: string, limit = 50) => many<WorkflowRow>(c, 'SELECT * FROM privacy_workflows WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2', [userId, limit]),
  recentWrites: async (c: C, userId: string) => Number((await one<{ n: number }>(c,
    `SELECT count(*)::int AS n FROM tool_receipts WHERE user_id = $1 AND tool = 'execute_approved_action' AND created_at > now() - interval '1 hour'`, [userId]))?.n ?? 0),
};

export const proposals = {
  insert: (c: C, p: Omit<ProposalRow, 'created_at'>) =>
    c.query(`INSERT INTO action_proposals(id, user_id, thread_id, action, alias_id, sender_id, provider_id, risk_tier, reversible, action_hash, explanation)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
      [p.id, p.user_id, p.thread_id, p.action, p.alias_id, p.sender_id, p.provider_id, p.risk_tier, p.reversible, p.action_hash, JSON.stringify(p.explanation)]),
  get: (c: C, userId: string, id: string) => one<ProposalRow>(c, 'SELECT * FROM action_proposals WHERE user_id = $1 AND id = $2', [userId, id]),
};

export const receipts = {
  /** Claims the idempotency key. Returns { row, created } — created=false means this exact action already ran or is running. */
  claim: async (c: C, r: Pick<ReceiptRow, 'user_id' | 'thread_id' | 'proposal_id' | 'idempotency_key' | 'tool' | 'mode' | 'sanitized_input'>) => {
    const inserted = await one<ReceiptRow>(c, `INSERT INTO tool_receipts(id, user_id, thread_id, proposal_id, idempotency_key, tool, mode, status, sanitized_input)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'running',$8) ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING *`,
      [newId('rcpt'), r.user_id, r.thread_id, r.proposal_id, r.idempotency_key, r.tool, r.mode, JSON.stringify(r.sanitized_input)]);
    if (inserted) return { row: inserted, created: true };
    const existing = await one<ReceiptRow>(c, 'SELECT * FROM tool_receipts WHERE user_id = $1 AND idempotency_key = $2', [r.user_id, r.idempotency_key]);
    return { row: existing!, created: false };
  },
  update: (c: C, userId: string, id: string, patch: { status: string; attempts?: number; sanitized_output?: Record<string, unknown>; error_code?: string | null; commitment?: string | null }) =>
    one<ReceiptRow>(c, `UPDATE tool_receipts SET status = $3, attempts = COALESCE($4, attempts), sanitized_output = COALESCE($5::jsonb, sanitized_output),
      error_code = $6, commitment = COALESCE($7, commitment), updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING *`,
      [userId, id, patch.status, patch.attempts ?? null, patch.sanitized_output ? JSON.stringify(patch.sanitized_output) : null, patch.error_code ?? null, patch.commitment ?? null]),
  get: (c: C, userId: string, id: string) => one<ReceiptRow>(c, 'SELECT * FROM tool_receipts WHERE user_id = $1 AND id = $2', [userId, id]),
  forThread: (c: C, userId: string, threadId: string) => many<ReceiptRow>(c, 'SELECT * FROM tool_receipts WHERE user_id = $1 AND thread_id = $2 ORDER BY created_at', [userId, threadId]),
  list: (c: C, userId: string, limit = 100) => many<ReceiptRow>(c, 'SELECT * FROM tool_receipts WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2', [userId, limit]),
};

export const policies = {
  list: (c: C, userId: string) => many<PolicyRow>(c, 'SELECT * FROM privacy_policies WHERE user_id = $1 ORDER BY created_at DESC', [userId]),
  insert: (c: C, p: Omit<PolicyRow, 'created_at'>) =>
    one<PolicyRow>(c, `INSERT INTO privacy_policies(id, user_id, kind, action, alias_id, sender_domain, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [p.id, p.user_id, p.kind, p.action, p.alias_id, p.sender_domain, p.expires_at]),
  remove: (c: C, userId: string, id: string) => c.query('DELETE FROM privacy_policies WHERE user_id = $1 AND id = $2', [userId, id]),
};
