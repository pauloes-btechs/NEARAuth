import type pg from 'pg';
import type { Database } from './db/pool.js';
import type { Embedder } from './llm.js';
import { toVector } from './llm.js';
import { AgentError, newId } from './util.js';

/* Semantic memory over NON-SECRET text only: shared playbooks, service names, incident summaries (masked aliases),
 * and notes the user explicitly approves. Anything that looks like a credential is refused before embedding.
 * Exact relational lookup — not vectors — is used for ownership, authorization and tool execution. */

const SECRETISH = [
  /\b(password|passwd|pwd|secret|api[ _-]?key|token|bearer|private key|seed phrase|mnemonic)\b\s*[:=]/i,
  /\b[A-Za-z0-9+/_-]{32,}={0,2}\b/,           // long high-entropy strings (keys, tokens)
  /ed25519:[1-9A-HJ-NP-Za-km-z]{40,}/,          // NEAR keys
  /-----BEGIN [A-Z ]+-----/,
];
export function assertSafeForEmbedding(text: string) {
  if (SECRETISH.some((re) => re.test(text))) throw new AgentError('unsafe_memory', 'This text looks like it contains a secret, so it was not stored', 422);
}

export const PLAYBOOKS: { ref: string; content: string }[] = [
  { ref: 'pb-unexpected-sender', content: 'Unexpected sender on an alias: an address given to one company receiving mail from an unrelated organisation. It shows the address reached someone else (sharing, a breach, a data broker or guessing); it does not prove the company sold it. Least disruptive response: block that one sender on that alias and keep the alias working for the original service.' },
  { ref: 'pb-processor', content: 'Payment processors, delivery companies and support desks often email on a merchant\'s behalf (receipts, shipping updates, security notices). Blocking them can hide important mail. Verify before blocking; prefer flagging.' },
  { ref: 'pb-unsubscribe', content: 'Unsubscribe safely: only use RFC 8058 one-click unsubscribe when the List-Unsubscribe headers are covered by a valid DKIM signature from the sender\'s own domain. Following links in forged mail confirms your address to spammers. When headers cannot be verified, block the sender instead.' },
  { ref: 'pb-compromised', content: 'Compromised account or leaked alias: pause the alias to stop all mail, rotate the account password on the service\'s own website, create a fresh alias for the service, then resume or delete the old one.' },
  { ref: 'pb-rotation', content: 'Password rotation checklist: sign in on the service\'s official site, change the password to a new generated one, store it in the vault, sign out other sessions, enable two-factor authentication if offered.' },
  { ref: 'pb-dormant', content: 'Dormant accounts: accounts with no activity for months still hold your data. Consider requesting deletion on the service\'s site, then pausing its alias. NEARAuth cannot delete third-party accounts for you.' },
];

export class Memory {
  constructor(private db: Database, private embedder: Embedder) {}
  get model() { return this.embedder.model; }

  private async insert(c: pg.PoolClient, row: { userId: string | null; docType: string; refId: string | null; content: string; approved: boolean }) {
    assertSafeForEmbedding(row.content);
    const [v] = await this.embedder.embed([row.content]);
    const id = newId('emb');
    await c.query(`INSERT INTO privacy_embeddings(id, user_id, doc_type, ref_id, content, model, embedding, approved_by_user)
      VALUES ($1,$2,$3,$4,$5,$6,$7::vector,$8)`, [id, row.userId, row.docType, row.refId, row.content, this.embedder.model, toVector(v), row.approved]);
    return id;
  }

  async seedPlaybooks() {
    await this.db.withSystem(async (c) => {
      const have = new Set((await c.query(`SELECT ref_id FROM privacy_embeddings WHERE user_id IS NULL AND doc_type = 'playbook' AND model = $1`, [this.embedder.model])).rows.map((r) => r.ref_id));
      for (const p of PLAYBOOKS) if (!have.has(p.ref)) await this.insert(c, { userId: null, docType: 'playbook', refId: p.ref, content: p.content, approved: false });
    });
  }

  /** Index service names so "the shoe shop" or "nova mkt" can be matched to an alias when no exact match exists. */
  async indexServiceNames(userId: string, items: { aliasId: string; serviceName: string; serviceDomain: string }[]) {
    await this.db.withUser(userId, async (c) => {
      await c.query(`DELETE FROM privacy_embeddings WHERE user_id = $1 AND doc_type = 'service_name' AND model = $2`, [userId, this.embedder.model]);
      for (const i of items) await this.insert(c, { userId, docType: 'service_name', refId: i.aliasId, content: `${i.serviceName} ${i.serviceDomain}`, approved: false });
    });
  }

  async search(userId: string, query: string, docTypes: string[], k = 4) {
    const [v] = await this.embedder.embed([query]);
    return this.db.withUser(userId, async (c) => (await c.query(
      `SELECT id, doc_type, ref_id, content, user_id IS NULL AS shared, (embedding <=> $1::vector) AS distance
       FROM privacy_embeddings WHERE model = $2 AND doc_type = ANY($3) AND (user_id IS NULL OR user_id = $4)
       ORDER BY embedding <=> $1::vector LIMIT $5`, [toVector(v), this.embedder.model, docTypes, userId, k])).rows
      .map((r) => ({ id: r.id as string, docType: r.doc_type as string, refId: r.ref_id as string | null, content: r.content as string, shared: !!r.shared, distance: Number(r.distance) })));
  }

  async addIncidentSummary(userId: string, refId: string, summary: string, optOut: boolean) {
    if (optOut) return null;
    return this.db.withUser(userId, (c) => this.insert(c, { userId, docType: 'incident_summary', refId, content: summary, approved: false }));
  }

  async remember(userId: string, content: string, optOut: boolean) {
    if (optOut) throw new AgentError('memory_opted_out', 'Learned memory is switched off for this account', 409);
    return this.db.withUser(userId, (c) => this.insert(c, { userId, docType: 'memory', refId: null, content: content.slice(0, 500), approved: true }));
  }

  list(userId: string) {
    return this.db.withUser(userId, async (c) => (await c.query(
      `SELECT id, doc_type, ref_id, content, model, approved_by_user, created_at FROM privacy_embeddings WHERE user_id = $1 ORDER BY created_at DESC`, [userId])).rows);
  }
  remove(userId: string, id: string) {
    return this.db.withUser(userId, async (c) => (await c.query('DELETE FROM privacy_embeddings WHERE user_id = $1 AND id = $2', [userId, id])).rowCount ?? 0);
  }
  clear(userId: string) {
    return this.db.withUser(userId, async (c) => (await c.query('DELETE FROM privacy_embeddings WHERE user_id = $1', [userId])).rowCount ?? 0);
  }
}
