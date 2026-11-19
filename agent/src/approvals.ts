import type pg from 'pg';
import { AgentError, hmac, newId, safeEqualHex } from './util.js';

/* Approvals are specific (bound to one action hash), user-bound, expiring and single-use.
 *   pending ──decide()──▶ approved | declined     (atomic: UPDATE … WHERE status = 'pending')
 *   approved ──consume()──▶ consumed              (atomic: UPDATE … WHERE status = 'approved')
 * The MAC binds every field that matters, so a row edited in the database (or a swapped action hash) fails. */

export interface ApprovalRow {
  id: string; user_id: string; thread_id: string; proposal_id: string; action_hash: string; mac: string; status: string;
  created_at: Date; expires_at: Date; decided_at: Date | null; consumed_at: Date | null; decided_by_session: string | null;
}

const macInput = (a: Pick<ApprovalRow, 'id' | 'user_id' | 'thread_id' | 'proposal_id' | 'action_hash' | 'expires_at'>) =>
  [a.id, a.user_id, a.thread_id, a.proposal_id, a.action_hash, new Date(a.expires_at).toISOString()].join('|');

export class Approvals {
  constructor(private key: Buffer, private ttlMs: number) {}

  private verifyMac(a: ApprovalRow) {
    if (!safeEqualHex(hmac(this.key, macInput(a)), a.mac)) throw new AgentError('approval_tampered', 'Approval record failed its integrity check', 409);
  }

  /** Idempotent: a LangGraph interrupt re-runs its node on resume, so the same pending approval must come back. */
  async getOrCreate(c: pg.PoolClient, p: { userId: string; threadId: string; proposalId: string; actionHash: string }): Promise<ApprovalRow> {
    const existing = (await c.query(`SELECT * FROM action_approvals WHERE user_id = $1 AND thread_id = $2 AND action_hash = $3
      ORDER BY created_at DESC LIMIT 1`, [p.userId, p.threadId, p.actionHash])).rows[0] as ApprovalRow | undefined;
    if (existing) return existing;
    const row = { id: newId('apr'), user_id: p.userId, thread_id: p.threadId, proposal_id: p.proposalId, action_hash: p.actionHash,
      expires_at: new Date(Date.now() + this.ttlMs) };
    const mac = hmac(this.key, macInput(row));
    return (await c.query(`INSERT INTO action_approvals(id, user_id, thread_id, proposal_id, action_hash, mac, status, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,'pending',$7) RETURNING *`, [row.id, row.user_id, row.thread_id, row.proposal_id, row.action_hash, mac, row.expires_at])).rows[0];
  }

  async get(c: pg.PoolClient, userId: string, id: string): Promise<ApprovalRow | null> {
    return (await c.query('SELECT * FROM action_approvals WHERE user_id = $1 AND id = $2', [userId, id])).rows[0] ?? null;
  }

  /** The human decision. The client must echo the action hash it displayed, so a changed proposal cannot be approved blind. */
  async decide(c: pg.PoolClient, p: { userId: string; threadId: string; approvalId: string; actionHash: string; decision: 'approve' | 'decline'; sessionId: string }): Promise<ApprovalRow> {
    const a = await this.get(c, p.userId, p.approvalId);
    if (!a || a.thread_id !== p.threadId) throw new AgentError('approval_not_found', 'No such approval for this workflow', 404);
    this.verifyMac(a);
    if (!safeEqualHex(a.action_hash, p.actionHash)) throw new AgentError('approval_mismatch', 'The action you approved is not the action awaiting approval', 409);
    if (a.status !== 'pending') throw new AgentError('approval_used', `This approval is already ${a.status}`, 409);
    if (new Date(a.expires_at).getTime() <= Date.now()) {
      await c.query(`UPDATE action_approvals SET status = 'expired' WHERE id = $1 AND status = 'pending'`, [a.id]);
      throw new AgentError('approval_expired', 'This approval expired. Ask again to get a fresh one.', 410);
    }
    const status = p.decision === 'approve' ? 'approved' : 'declined';
    const updated = (await c.query(`UPDATE action_approvals SET status = $2, decided_at = now(), decided_by_session = $3
      WHERE id = $1 AND status = 'pending' RETURNING *`, [a.id, status, p.sessionId])).rows[0];
    if (!updated) throw new AgentError('approval_used', 'This approval was decided concurrently', 409);
    return updated;
  }

  /**
   * Called by the execute node after resume. Accepts an approval that this same workflow already consumed,
   * because a crash between consume and finish must be able to resume (the receipt's idempotency key then
   * prevents a second side effect). Anything else is refused.
   */
  async consume(c: pg.PoolClient, p: { userId: string; threadId: string; approvalId: string; actionHash: string }): Promise<'consumed' | 'resumed'> {
    const a = await this.get(c, p.userId, p.approvalId);
    if (!a || a.thread_id !== p.threadId) throw new AgentError('approval_not_found', 'No such approval for this workflow', 404);
    this.verifyMac(a);
    if (!safeEqualHex(a.action_hash, p.actionHash)) throw new AgentError('approval_mismatch', 'Approved action differs from the action about to run', 409);
    if (a.status === 'consumed') return 'resumed';
    if (a.status !== 'approved') throw new AgentError('approval_not_granted', `Approval is ${a.status}`, 409);
    if (new Date(a.expires_at).getTime() <= Date.now()) {
      await c.query(`UPDATE action_approvals SET status = 'expired' WHERE id = $1 AND status = 'approved'`, [a.id]);
      throw new AgentError('approval_expired', 'The approval expired before the action could run', 410);
    }
    const updated = (await c.query(`UPDATE action_approvals SET status = 'consumed', consumed_at = now() WHERE id = $1 AND status = 'approved' RETURNING id`, [a.id])).rows[0];
    if (!updated) throw new AgentError('approval_used', 'Approval was consumed concurrently', 409);
    return 'consumed';
  }
}
