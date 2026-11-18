import { z } from 'zod';
import type { Database } from '../db/pool.js';
import { aliases, proposals, receipts, senders, workflows, type AliasRow, type SenderRow } from '../db/repo.js';
import type { Approvals } from '../approvals.js';
import type { Memory } from '../memory.js';
import { isReversible, thirdPartyCategory, type ActionKind } from '../policy.js';
import { ProviderError, type ProviderAdapter } from '../providers/types.js';
import { AgentError, canonicalJson, Detection, maskAlias, newId, sanitize, sha256, sleep } from '../util.js';
import { Id, ToolRegistry, isGrant, type ToolContext } from './registry.js';

export interface ToolDeps { db: Database; provider: ProviderAdapter; memory: Memory; approvals: Approvals }

export const publicAlias = (a: AliasRow) => ({
  id: a.id, alias: maskAlias(a.alias_email), service: a.service_name, serviceDomain: a.service_domain, provider: a.provider_id,
  enabled: a.enabled, credentialStatus: a.credential_status, lastActivity: a.last_activity_at, created: a.created_at,
});
export const publicSender = (s: SenderRow) => ({
  id: s.id, aliasId: s.alias_id, address: s.sender_address, domain: s.sender_domain, displayName: s.sender_display_name,
  blocked: s.blocked, classification: s.classification, confidence: s.confidence, observedAt: s.observed_at,
});

/** The canonical description of an action. Any change to the target (alias email, provider id, remote ids, sender) changes the hash. */
export function actionHashOf(userId: string, action: ActionKind, alias: AliasRow, sender: SenderRow | null) {
  return sha256(canonicalJson({
    v: 1, userId, action, aliasId: alias.id, aliasEmail: alias.alias_email, providerId: alias.provider_id, remoteId: alias.remote_id,
    senderId: sender?.id ?? null, senderAddress: sender?.sender_address ?? null, remoteContactId: sender?.remote_contact_id ?? null,
  }));
}

const EFFECT: Record<ActionKind, (a: AliasRow, s: SenderRow | null) => string> = {
  block_sender: (a, s) => `Mail from ${s!.sender_address} to your ${a.service_name} alias will be dropped. ${a.service_name} and everyone else can still reach you.`,
  unblock_sender: (a, s) => `Mail from ${s!.sender_address} to your ${a.service_name} alias will be delivered again.`,
  pause_alias: (a) => `All mail to your ${a.service_name} alias stops, including mail from ${a.service_name}.`,
  resume_alias: (a) => `Mail to your ${a.service_name} alias is delivered again.`,
  unsubscribe: (_a, s) => `NEARAuth would ask ${s?.sender_domain ?? 'the sender'} to stop sending. Not available with sender metadata only.`,
  credential_rotation: (a) => `A checklist for changing your ${a.service_name} password on its own website.`,
};
const TITLE: Record<ActionKind, string> = {
  block_sender: 'Block one sender on one alias', unblock_sender: 'Unblock one sender', pause_alias: 'Pause the alias',
  resume_alias: 'Resume the alias', unsubscribe: 'Unsubscribe', credential_rotation: 'Rotate the password',
};
const INVERSE: Partial<Record<ActionKind, ActionKind>> = { block_sender: 'unblock_sender', unblock_sender: 'block_sender', pause_alias: 'resume_alias', resume_alias: 'pause_alias' };
export const inverseOf = (a: ActionKind) => INVERSE[a] ?? null;

export function buildTools(deps: ToolDeps): ToolRegistry {
  const { db, provider, memory, approvals } = deps;
  const r = new ToolRegistry();
  const loadAlias = async (userId: string, aliasId: string) => {
    const a = await db.withUser(userId, (c) => aliases.get(c, userId, aliasId));
    if (!a) throw new AgentError('not_found', 'No such alias for this user', 404);
    return a;
  };
  const loadSender = async (userId: string, senderId: string, aliasId: string) => {
    const s = await db.withUser(userId, (c) => senders.get(c, userId, senderId));
    if (!s || s.alias_id !== aliasId) throw new AgentError('not_found', 'No such sender on this alias', 404);
    return s;
  };

  /* ------------------------------------------------------------------ read */
  r.register({
    name: 'list_user_aliases', kind: 'read', callers: ['node', 'api', 'llm'], description: 'List the signed-in user\'s aliases (masked).',
    input: z.object({}).strict(),
    run: async (ctx) => (await db.withUser(ctx.userId, (c) => aliases.list(c, ctx.userId))).map(publicAlias),
    summarize: (out) => ({ count: (out as unknown[]).length }),
  });
  r.register({
    name: 'get_alias_status', kind: 'read', callers: ['node', 'api', 'llm'], description: 'Alias record, optionally re-read from the provider.',
    input: z.object({ aliasId: Id, fresh: z.boolean().default(false) }).strict(),
    run: async (ctx, i) => {
      const a = await loadAlias(ctx.userId, i.aliasId);
      let remote: { enabled: boolean; emailMatches: boolean } | null = null;
      if (i.fresh && a.remote_id && a.provider_id === provider.id) {
        const ra = await provider.getAlias(a.remote_id);
        remote = { enabled: ra.enabled, emailMatches: ra.email.toLowerCase() === a.alias_email.toLowerCase() };
      }
      return { alias: publicAlias(a), remote };
    },
  });
  r.register({
    name: 'get_alias_sender_events', kind: 'read', callers: ['node', 'api', 'llm'],
    description: 'Senders observed on an alias. With fresh=true, re-reads the provider and records new senders (classified locally).',
    input: z.object({ aliasId: Id, fresh: z.boolean().default(false) }).strict(),
    run: async (ctx, i) => {
      const a = await loadAlias(ctx.userId, i.aliasId);
      if (i.fresh && a.remote_id && a.provider_id === provider.id && provider.capabilities.listSenders) {
        const remote = await provider.listSenders(a.remote_id);
        await db.withUser(ctx.userId, async (c) => {
          const history: unknown[] = [];
          for (const s of remote) {
            const res = Detection.classify({ alias: a.alias_email, from: s.address }, { account: { name: a.service_name, domain: a.service_domain }, history });
            history.push(res);
            await senders.upsert(c, { user_id: ctx.userId, alias_id: a.id, sender_address: s.address, sender_domain: s.address.split('@')[1] ?? '',
              sender_display_name: null, remote_contact_id: s.remoteContactId, blocked: s.blocked, classification: res.classification, confidence: res.confidence });
          }
        });
      }
      return (await db.withUser(ctx.userId, (c) => senders.forAlias(c, ctx.userId, a.id))).map(publicSender);
    },
    summarize: (out) => ({ count: (out as unknown[]).length }),
  });
  r.register({
    name: 'investigate_incident', kind: 'read', callers: ['node', 'api', 'llm'],
    description: 'Classify one sender on one alias: evidence, confidence, possible innocent explanations, and relevant playbooks.',
    input: z.object({ aliasId: Id, senderId: Id }).strict(),
    run: async (ctx, i) => {
      const a = await loadAlias(ctx.userId, i.aliasId);
      const s = await loadSender(ctx.userId, i.senderId, a.id);
      const others = (await db.withUser(ctx.userId, (c) => senders.forAlias(c, ctx.userId, a.id))).filter((x) => x.id !== s.id && x.classification === 'unexpected');
      const result = Detection.classify({ alias: a.alias_email, from: s.sender_address }, {
        account: { name: a.service_name, domain: a.service_domain },
        history: others.map((o) => ({ classification: 'unexpected', senderDomain: Detection.registrableDomain(o.sender_domain), alias: a.alias_email })),
      });
      const category = thirdPartyCategory(s.sender_domain);
      const explanations = [
        ...(category ? [`${s.sender_domain} looks like a ${category}; it may be sending legitimate mail for ${a.service_name}.`] : []),
        `${a.service_name} may have shared the address with a partner or processor.`,
        'The address may have leaked in a breach or been bought by a data broker.',
        'Random-looking aliases are rarely guessed, but it is possible.',
      ];
      const playbooks = await memory.search(ctx.userId, `${result.summary} ${category ?? ''}`, ['playbook'], 2).catch(() => []);
      return {
        alias: publicAlias(a), sender: publicSender(s), classification: result.classification, confidence: result.confidence, summary: result.summary,
        evidence: result.evidence, thirdPartyCategory: category, possibleExplanations: explanations,
        caveat: 'Unexpected use is not proof that the address was sold.', playbooks: playbooks.map((p) => ({ ref: p.refId, text: p.content })),
      };
    },
    summarize: (o) => ({ classification: (o as { classification: string }).classification, confidence: (o as { confidence: string }).confidence }),
  });
  r.register({
    name: 'search_privacy_context', kind: 'read', callers: ['node', 'api', 'llm'], description: 'Semantic search over non-secret playbooks, incident summaries and approved memory.',
    input: z.object({ query: z.string().min(1).max(300), docTypes: z.array(z.enum(['playbook', 'incident_summary', 'memory', 'service_name', 'policy_text'])).default(['playbook', 'incident_summary', 'memory']), k: z.number().int().min(1).max(8).default(4) }).strict(),
    run: (ctx, i) => memory.search(ctx.userId, i.query, i.docTypes, i.k),
    summarize: (o) => ({ hits: (o as unknown[]).length }),
  });
  r.register({
    name: 'get_workflow_status', kind: 'read', callers: ['node', 'api', 'llm'], description: 'Status of one of the user\'s workflows.',
    input: z.object({ threadId: Id }).strict(),
    run: async (ctx, i) => {
      const w = await db.withUser(ctx.userId, (c) => workflows.get(c, ctx.userId, i.threadId));
      if (!w) throw new AgentError('not_found', 'No such workflow', 404);
      return { threadId: w.thread_id, status: w.status, intent: w.intent, mode: w.mode, summary: w.summary, updatedAt: w.updated_at };
    },
  });
  r.register({
    name: 'get_action_receipt', kind: 'read', callers: ['node', 'api', 'llm'], description: 'A sanitized execution receipt.',
    input: z.object({ receiptId: Id }).strict(),
    run: async (ctx, i) => {
      const rc = await db.withUser(ctx.userId, (c) => receipts.get(c, ctx.userId, i.receiptId));
      if (!rc) throw new AgentError('not_found', 'No such receipt', 404);
      return rc;
    },
  });

  /* ------------------------------------------------------------------ propose */
  const propose = (action: ActionKind, needsSender: boolean) => async (ctx: ToolContext, i: { aliasId: string; senderId?: string }) => {
    if (!ctx.threadId) throw new AgentError('no_thread', 'Proposals belong to a workflow', 400);
    const a = await loadAlias(ctx.userId, i.aliasId);
    const s = needsSender ? await loadSender(ctx.userId, i.senderId!, a.id) : null;
    const actionHash = actionHashOf(ctx.userId, action, a, s);
    const supported = action !== 'unsubscribe' && action !== 'credential_rotation';
    const proposal = {
      id: newId('prop'), action, aliasId: a.id, senderId: s?.id ?? null, providerId: a.provider_id, actionHash, reversible: isReversible(action),
      supported, title: TITLE[action], effect: EFFECT[action](a, s), undo: inverseOf(action),
      target: { alias: maskAlias(a.alias_email), service: a.service_name, serviceDomain: a.service_domain, sender: s?.sender_address ?? null },
      checklist: action === 'credential_rotation' ? [
        `Open ${a.service_domain} directly (not from an email link) and sign in.`, 'Change the password to a newly generated one and save it in the NEARAuth vault.',
        'Sign out of other sessions and turn on two-factor authentication if offered.', 'Come back and mark the account as rotated.',
      ] : undefined,
      alternative: action === 'unsubscribe' ? 'block_sender' : null,
    };
    await db.withUser(ctx.userId, (c) => proposals.insert(c, {
      id: proposal.id, user_id: ctx.userId, thread_id: ctx.threadId!, action, alias_id: a.id, sender_id: s?.id ?? null, provider_id: a.provider_id,
      risk_tier: 'medium', reversible: proposal.reversible, action_hash: actionHash, explanation: sanitize(proposal) as Record<string, unknown>,
    }));
    return proposal;
  };
  const AliasSender = z.object({ aliasId: Id, senderId: Id }).strict();
  const AliasOnly = z.object({ aliasId: Id }).strict();
  r.register({ name: 'propose_sender_block', kind: 'propose', callers: ['node'], description: 'Propose blocking one sender on one alias.', input: AliasSender, run: propose('block_sender', true) });
  r.register({ name: 'propose_sender_unblock', kind: 'propose', callers: ['node'], description: 'Propose unblocking one sender.', input: AliasSender, run: propose('unblock_sender', true) });
  r.register({ name: 'propose_alias_pause', kind: 'propose', callers: ['node'], description: 'Propose pausing an alias.', input: AliasOnly, run: propose('pause_alias', false) });
  r.register({ name: 'propose_alias_resume', kind: 'propose', callers: ['node'], description: 'Propose resuming an alias.', input: AliasOnly, run: propose('resume_alias', false) });
  r.register({ name: 'propose_unsubscribe', kind: 'propose', callers: ['node'], description: 'Propose an unsubscribe (reported unsupported without verified headers).', input: AliasSender, run: propose('unsubscribe', true) });
  r.register({ name: 'propose_credential_rotation', kind: 'propose', callers: ['node'], description: 'Produce a password-rotation checklist (no remote change).', input: AliasOnly, run: propose('credential_rotation', false) });

  /* ------------------------------------------------------------------ privileged */
  const Decision = z.object({ threadId: Id, approvalId: Id, actionHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
  r.register({
    name: 'approve_action', kind: 'privileged', callers: ['api'], description: 'Record the user\'s approval of one exact action (single use, expiring).', input: Decision,
    run: (ctx, i) => db.withUser(ctx.userId, (c) => approvals.decide(c, { userId: ctx.userId, threadId: i.threadId, approvalId: i.approvalId, actionHash: i.actionHash, decision: 'approve',
      sessionId: ctx.caller.type === 'api' ? ctx.caller.sessionId : 'unknown' })),
    summarize: (o) => ({ status: (o as { status: string }).status }),
  });
  r.register({
    name: 'deny_action', kind: 'privileged', callers: ['api'], description: 'Record that the user declined an action.', input: Decision,
    run: (ctx, i) => db.withUser(ctx.userId, (c) => approvals.decide(c, { userId: ctx.userId, threadId: i.threadId, approvalId: i.approvalId, actionHash: i.actionHash, decision: 'decline',
      sessionId: ctx.caller.type === 'api' ? ctx.caller.sessionId : 'unknown' })),
    summarize: (o) => ({ status: (o as { status: string }).status }),
  });
  r.register({
    name: 'cancel_workflow', kind: 'privileged', callers: ['api'], description: 'Cancel a workflow and expire its pending approvals.', input: z.object({ threadId: Id }).strict(),
    run: (ctx, i) => db.withUser(ctx.userId, async (c) => {
      const w = await workflows.get(c, ctx.userId, i.threadId);
      if (!w) throw new AgentError('not_found', 'No such workflow', 404);
      if (['verified', 'requested', 'failed', 'completed', 'denied', 'declined', 'unsupported', 'expired', 'cancelled'].includes(w.status)) throw new AgentError('already_finished', `Workflow is already ${w.status}`, 409);
      await c.query(`UPDATE action_approvals SET status = 'expired' WHERE user_id = $1 AND thread_id = $2 AND status IN ('pending', 'approved')`, [ctx.userId, i.threadId]);
      await workflows.update(c, ctx.userId, i.threadId, { status: 'cancelled', summary: 'Cancelled by you before anything ran.' });
      return { cancelled: true };
    }),
  });

  const ExecIn = z.object({ proposalId: Id, actionHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
  r.register({
    name: 'execute_approved_action', kind: 'privileged', callers: ['node'],
    description: 'Run one approved action through the provider adapter. Idempotent per approval; bounded retries for transient errors only.',
    input: ExecIn,
    run: async (ctx, i) => {
      const g = ctx.grant!;
      if (!isGrant(g) || g.proposalId !== i.proposalId || g.actionHash !== i.actionHash || g.threadId !== ctx.threadId) throw new AgentError('grant_mismatch', 'Grant does not cover this action', 403);
      const p = await db.withUser(ctx.userId, (c) => proposals.get(c, ctx.userId, i.proposalId));
      if (!p) throw new AgentError('not_found', 'No such proposal', 404);
      const a = await loadAlias(ctx.userId, p.alias_id!);
      const s = p.sender_id ? await loadSender(ctx.userId, p.sender_id, a.id) : null;
      if (actionHashOf(ctx.userId, p.action as ActionKind, a, s) !== i.actionHash) throw new AgentError('target_changed', 'The target changed after approval; nothing was done', 409);
      if (a.provider_id !== provider.id || !a.remote_id) throw new AgentError('unsupported_provider', 'This alias is not managed by the configured provider', 409);

      const idem = sha256(`${g.approvalId ?? g.policyId}|${i.proposalId}|${i.actionHash}`);
      const claim = await db.withUser(ctx.userId, (c) => receipts.claim(c, {
        user_id: ctx.userId, thread_id: ctx.threadId!, proposal_id: p.id, idempotency_key: idem, tool: 'execute_approved_action', mode: provider.mode,
        sanitized_input: { action: p.action, alias: maskAlias(a.alias_email), aliasId: a.id, sender: s?.sender_address ?? null, provider: provider.id, mode: provider.mode },
      }));
      if (!claim.created && claim.row.status !== 'running') return { receiptId: claim.row.id, status: claim.row.status, attempts: claim.row.attempts, duplicate: true };

      let attempts = claim.row.attempts;
      for (;;) {
        attempts++;
        try {
          if (p.action === 'block_sender' || p.action === 'unblock_sender') await provider.setSenderBlocked(a.remote_id, s!.remote_contact_id!, p.action === 'block_sender');
          else if (p.action === 'pause_alias' || p.action === 'resume_alias') await provider.setAliasEnabled(a.remote_id, p.action === 'resume_alias');
          else throw new ProviderError('unsupported', `${p.action} cannot be executed`, false);
          const row = await db.withUser(ctx.userId, (c) => receipts.update(c, ctx.userId, claim.row.id, { status: 'requested', attempts, error_code: null }));
          return { receiptId: row!.id, status: 'requested', attempts, duplicate: !claim.created };
        } catch (e) {
          // Unknown failures (a crash, a bug, a lost DB connection) leave the outcome unknown: keep the receipt
          // 'running' and let the error stop the run. Resuming re-reads provider state, so it converges without a second toggle.
          if (!(e instanceof ProviderError)) throw e;
          const err = e;
          const transient = err.transient;
          if (transient && attempts < 3) { await sleep(150 * 2 ** (attempts - 1)); continue; }
          await db.withUser(ctx.userId, (c) => receipts.update(c, ctx.userId, claim.row.id, { status: 'failed', attempts, error_code: err.code || 'error',
            sanitized_output: { message: transient ? 'The provider kept failing; nothing more will be retried automatically.' : err.message } }));
          return { receiptId: claim.row.id, status: 'failed', attempts, errorCode: err.code || 'error', duplicate: false };
        }
      }
    },
  });
  r.register({
    name: 'verify_action', kind: 'privileged', callers: ['node'], description: 'Re-read authoritative provider state and mark the receipt verified or failed.',
    input: z.object({ receiptId: Id, proposalId: Id }).strict(),
    run: async (ctx, i) => {
      if (!isGrant(ctx.grant) || ctx.grant.proposalId !== i.proposalId) throw new AgentError('grant_mismatch', 'Grant does not cover this action', 403);
      const p = (await db.withUser(ctx.userId, (c) => proposals.get(c, ctx.userId, i.proposalId)))!;
      const a = await loadAlias(ctx.userId, p.alias_id!);
      const s = p.sender_id ? await loadSender(ctx.userId, p.sender_id, a.id) : null;
      if (!provider.capabilities.readBack) return { status: 'requested', detail: 'The provider cannot report its state, so the change is submitted but unverified.' };
      let ok = false, observed: Record<string, unknown> = {};
      if (s) {
        const remote = (await provider.listSenders(a.remote_id!)).find((x) => x.remoteContactId === s.remote_contact_id);
        observed = { senderBlocked: remote?.blocked ?? null };
        ok = !!remote && remote.blocked === (p.action === 'block_sender');
      } else {
        const ra = await provider.getAlias(a.remote_id!);
        observed = { aliasEnabled: ra.enabled };
        ok = ra.enabled === (p.action === 'resume_alias');
      }
      await db.withUser(ctx.userId, async (c) => {
        await receipts.update(c, ctx.userId, i.receiptId, { status: ok ? 'verified' : 'failed', error_code: ok ? null : 'verification_mismatch', sanitized_output: { observed, verifiedAt: new Date().toISOString() } });
        if (ok && s) await senders.setBlocked(c, ctx.userId, s.id, p.action === 'block_sender');
        if (ok && !s) await aliases.setEnabled(c, ctx.userId, a.id, p.action === 'resume_alias');
      });
      return { status: ok ? 'verified' : 'failed', observed };
    },
  });
  return r;
}
