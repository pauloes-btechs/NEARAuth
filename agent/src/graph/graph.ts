import { END, START, StateGraph, interrupt, type BaseCheckpointSaver } from '@langchain/langgraph';
import type { Database } from '../db/pool.js';
import { aliases, policies, senders, users, workflows, type AliasRow, type SenderRow } from '../db/repo.js';
import type { Approvals } from '../approvals.js';
import { recordAudit } from '../audit.js';
import { READ_INTENTS, WRITE_INTENTS, INTENT_LABELS, parseByRules, type Intent } from '../intents.js';
import type { IntentModel } from '../llm.js';
import type { Memory } from '../memory.js';
import { evaluatePolicy, thirdPartyCategory, type ActionKind } from '../policy.js';
import type { ProviderAdapter } from '../providers/types.js';
import { mintGrant, type ToolCall, type ToolRegistry } from '../tools/registry.js';
import { publicAlias, publicSender } from '../tools/index.js';
import { AgentError, Detection, maskAlias } from '../util.js';
import { PrivacyAgentState, type AliasRef, type Candidate, type ProposalView, type SenderRef, type State, type Update } from './state.js';

export interface GraphDeps {
  db: Database; tools: ToolRegistry; provider: ProviderAdapter; approvals: Approvals; memory: Memory; intentModel: IntentModel | null;
}

const ACTION_FOR: Partial<Record<Intent, { action: ActionKind; tool: string; sender: boolean }>> = {
  block_sender: { action: 'block_sender', tool: 'propose_sender_block', sender: true },
  unblock_sender: { action: 'unblock_sender', tool: 'propose_sender_unblock', sender: true },
  pause_alias: { action: 'pause_alias', tool: 'propose_alias_pause', sender: false },
  resume_alias: { action: 'resume_alias', tool: 'propose_alias_resume', sender: false },
  unsubscribe: { action: 'unsubscribe', tool: 'propose_unsubscribe', sender: true },
};
const NEEDS_ALIAS: Intent[] = ['investigate_sender', 'block_sender', 'unblock_sender', 'unsubscribe', 'pause_alias', 'resume_alias'];
const NEEDS_SENDER: Intent[] = ['block_sender', 'unblock_sender', 'unsubscribe'];

const aliasRef = (a: AliasRow): AliasRef => ({ id: a.id, masked: maskAlias(a.alias_email), service: a.service_name, serviceDomain: a.service_domain, providerId: a.provider_id });
const senderRef = (s: SenderRow): SenderRef => ({ id: s.id, address: s.sender_address, domain: s.sender_domain, blocked: s.blocked, classification: s.classification });
const senderLabel = (s: SenderRow) => { const cat = thirdPartyCategory(s.sender_domain); return `${s.sender_address}${cat ? ` — looks like a ${cat}` : ''}`; };
const GENERIC = new Set(['market', 'shop', 'store', 'forum', 'online', 'club', 'group', 'service', 'services', 'company', 'account', 'alias']);
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const stamp = (node: string) => ({ path: [node], timestamps: { [node]: new Date().toISOString() } });

export function buildGraph(deps: GraphDeps, checkpointer: BaseCheckpointSaver) {
  const { db, tools, provider, approvals, memory, intentModel } = deps;

  /** Invokes a tool on behalf of a node and returns the result plus the timeline entry for the state. */
  async function call<T>(state: State, node: string, name: string, input: unknown, grant?: Parameters<typeof mintGrant>[0]): Promise<{ out: T; calls: ToolCall[] }> {
    const calls: ToolCall[] = [];
    const out = await tools.invoke<T>(name, input, { userId: state.userId, caller: { type: 'node', node }, threadId: state.threadId, grant: grant ? mintGrant(grant) : undefined }, calls);
    return { out, calls };
  }
  const persist = (state: State, patch: { status?: string; intent?: string; summary?: string }) =>
    db.withUser(state.userId, (c) => workflows.update(c, state.userId, state.threadId, { ...patch, path: state.path }));

  /* 1 ─ Parse intent */
  async function parse_intent(state: State): Promise<Update> {
    if (state.structured?.intent) return { ...stamp('parse_intent'), intent: state.structured.intent, intentSource: 'structured' };
    const parsed = parseByRules(state.requestText);
    let intent = parsed.intent, source: 'rules' | 'llm' = 'rules';
    const calls: ToolCall[] = [];
    if (intent === 'unknown' && intentModel) {
      const t0 = Date.now();
      const m = await intentModel.classify(state.requestText);
      calls.push({ tool: 'intent_model', kind: 'read', caller: `model:${intentModel.name}`, input: { text: '[request text]' }, output: { intent: m }, status: m ? 'ok' : 'error', error: m ? undefined : 'model unavailable or invalid reply; using rules', ms: Date.now() - t0, at: new Date().toISOString() });
      if (m) { intent = m; source = 'llm'; }
    }
    return { ...stamp('parse_intent'), intent, intentSource: source, mentions: { emails: parsed.mentionedEmails, domains: parsed.mentionedDomains }, toolCalls: calls };
  }

  /* 2 ─ Authenticate & authorize */
  async function authorize(state: State): Promise<Update> {
    const user = await db.withUser(state.userId, (c) => users.get(c, state.userId));
    if (!user) return { ...stamp('authorize'), errorCode: 'unknown_user', explanation: 'This session does not belong to a known user.' };
    if (!user.agent_enabled) return { ...stamp('authorize'), errorCode: 'agent_disabled', explanation: 'Agentic features are switched off for your account (Policy & Permissions).' };
    await persist(state, { intent: state.intent ?? undefined });
    return { ...stamp('authorize'), errorCode: null };
  }

  /* 3 ─ Resolve target (exact first; vectors only to suggest a service name) */
  async function resolve_target(state: State): Promise<Update> {
    const intent = state.intent!;
    if (!NEEDS_ALIAS.includes(intent)) return { ...stamp('resolve_target'), resolution: { method: 'not-needed', detail: 'This request covers all of your aliases.' } };
    const calls: ToolCall[] = [];
    const all = await db.withUser(state.userId, (c) => aliases.list(c, state.userId));
    const text = state.requestText.toLowerCase();
    const want = state.structured ?? {};
    let alias: AliasRow | null = null, method = '';

    if (want.aliasId) { alias = all.find((a) => a.id === want.aliasId) ?? null; method = 'selected id'; if (!alias) return { ...stamp('resolve_target'), errorCode: 'not_owned', explanation: 'That alias is not one of yours.' }; }
    if (!alias && state.mentions.emails.length) { alias = all.find((a) => state.mentions.emails.includes(a.alias_email.toLowerCase())) ?? null; method = 'exact alias email'; }
    if (!alias) {
      // Exact: the full service name or domain appears; otherwise the alias whose distinctive name words appear most.
      let hits = all.filter((a) => squash(text).includes(squash(a.service_name)) || text.includes(a.service_domain) || state.mentions.domains.includes(a.service_domain));
      if (!hits.length) {
        const words = new Set(text.split(/[^a-z0-9]+/));
        const score = (a: AliasRow) => a.service_name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !GENERIC.has(w) && words.has(w)).length;
        const best = Math.max(0, ...all.map(score));
        if (best > 0) hits = all.filter((a) => score(a) === best);
      }
      if (hits.length === 1) { alias = hits[0]; method = 'exact service name'; }
      else if (hits.length > 1) return ambiguous(hits.map((a) => ({ aliasId: a.id, label: `${a.service_name} — ${maskAlias(a.alias_email)}` })), calls);
    }

    // No alias named: for sender intents, look for the single alias that has a matching sender.
    let sender: SenderRow | null = null;
    const senderFilter = (s: SenderRow) => intent === 'unblock_sender' ? s.blocked : !s.blocked && s.classification === 'unexpected';
    const mentionsSender = (s: SenderRow) => state.mentions.emails.includes(s.sender_address) || state.mentions.domains.some((d) => Detection.registrableDomain(d) === Detection.registrableDomain(s.sender_domain));
    if (!alias && (NEEDS_SENDER.includes(intent) || intent === 'investigate_sender')) {
      const pool = (await db.withUser(state.userId, (c) => senders.all(c, state.userId)));
      const named = pool.filter(mentionsSender);
      const matches = named.length ? named : pool.filter(senderFilter);
      const pairs = matches.map((s) => ({ s, a: all.find((a) => a.id === s.alias_id)! })).filter((p) => p.a);
      if (pairs.length === 1) { alias = pairs[0].a; sender = pairs[0].s; method = named.length ? 'sender named in request' : 'only alias with a matching sender'; }
      else if (pairs.length > 1) return ambiguous(pairs.map((p) => ({ aliasId: p.a.id, senderId: p.s.id, label: `${senderLabel(p.s)} → ${p.a.service_name} (${maskAlias(p.a.alias_email)})` })), calls);
    }
    if (!alias && all.length > 1) {
      // Semantic suggestion only: never acted on without the user's pick.
      const near = await memory.search(state.userId, state.requestText, ['service_name'], 3).catch(() => []);
      const close = near.filter((h) => h.distance < 0.55 && h.refId).map((h) => all.find((a) => a.id === h.refId)).filter(Boolean) as AliasRow[];
      if (close.length) return ambiguous(close.map((a) => ({ aliasId: a.id, label: `${a.service_name} — ${maskAlias(a.alias_email)} (similar name)` })), calls, 'semantic suggestion');
    }
    if (!alias && all.length === 1) { alias = all[0]; method = 'your only alias'; }
    if (!alias) {
      if (!all.length) return { ...stamp('resolve_target'), errorCode: 'no_aliases', explanation: 'You have no aliases synced to the agent yet.' };
      return ambiguous(all.map((a) => ({ aliasId: a.id, label: `${a.service_name} — ${maskAlias(a.alias_email)}` })), calls);
    }

    // Refresh sender state from the provider so decisions use authoritative data.
    let providerReachable = true;
    if (alias.provider_id === provider.id) {
      try { calls.push(...(await call(state, 'resolve_target', 'get_alias_sender_events', { aliasId: alias.id, fresh: true })).calls); }
      catch (e) { providerReachable = false; calls.push({ tool: 'get_alias_sender_events', kind: 'read', caller: 'node:resolve_target', input: { aliasId: alias.id, fresh: true }, output: null, status: 'error', error: (e as AgentError).code ?? 'provider_error', ms: 0, at: new Date().toISOString() }); }
    }
    if (NEEDS_SENDER.includes(intent) || intent === 'investigate_sender') {
      const list = await db.withUser(state.userId, (c) => senders.forAlias(c, state.userId, alias!.id));
      if (want.senderId) {
        sender = list.find((s) => s.id === want.senderId) ?? null;
        if (!sender) return { ...stamp('resolve_target'), errorCode: 'not_owned', explanation: 'That sender was not observed on this alias.' };
        method += ' + selected sender';
      } else if (sender) {
        sender = list.find((s) => s.id === sender!.id) ?? sender;
      } else {
        const named = list.filter(mentionsSender);
        const matches = named.length ? named : list.filter(senderFilter);
        if (matches.length === 1) { sender = matches[0]; method += named.length ? ' + sender named in request' : ' + only matching sender'; }
        else if (matches.length > 1) return ambiguous(matches.map((s) => ({ aliasId: alias!.id, senderId: s.id, label: `${senderLabel(s)} (${s.classification ?? 'unclassified'})` })), calls);
        else if (intent !== 'investigate_sender') {
          return { ...stamp('resolve_target'), toolCalls: calls, aliasRef: aliasRef(alias), errorCode: 'no_sender',
            explanation: intent === 'unblock_sender' ? `No blocked senders on your ${alias.service_name} alias.` : `No unexpected senders are recorded on your ${alias.service_name} alias, so there is nothing to block. (Senders from ${alias.service_name} itself are never blocked.)` };
        }
      }
    }
    return { ...stamp('resolve_target'), toolCalls: calls, aliasRef: aliasRef(alias), senderRef: sender ? senderRef(sender) : null, candidates: [], errorCode: null,
      resolution: { method, detail: `${alias.service_name} (${maskAlias(alias.alias_email)})${sender ? ' · sender ' + sender.sender_address : ''}` },
      remoteState: { providerReachable } };

    function ambiguous(candidates: Candidate[], calls: ToolCall[], how = 'exact match'): Update {
      return { ...stamp('resolve_target'), toolCalls: calls, candidates: candidates.slice(0, 8), resolution: { method: 'ambiguous', detail: `${candidates.length} possible targets (${how})` }, errorCode: null };
    }
  }

  /* interrupt ─ ask the user to pick a target */
  async function select_target(state: State): Promise<Update> {
    await persist(state, { status: 'needs_target', summary: 'Waiting for you to choose which alias or sender you meant.' });
    const picked = interrupt({ type: 'select_target', question: 'Which one did you mean?', candidates: state.candidates }) as { aliasId: string; senderId?: string };
    const ok = state.candidates.some((c) => c.aliasId === picked?.aliasId && (c.senderId ?? null) === (picked?.senderId ?? null));
    if (!ok) return { ...stamp('select_target'), errorCode: 'invalid_selection', candidates: [] };
    return { ...stamp('select_target'), structured: { ...(state.structured ?? {}), aliasId: picked.aliasId, senderId: picked.senderId }, candidates: [] };
  }

  /* 4 ─ Retrieve context */
  async function retrieve_context(state: State): Promise<Update> {
    const calls: ToolCall[] = [];
    const intent = state.intent!;
    const evidence: string[] = [];
    let findings: Record<string, unknown> | null = null;
    let remote = state.remoteState ?? { providerReachable: true };
    if (state.aliasRef && state.senderRef) {
      const inv = await call<Record<string, unknown>>(state, 'retrieve_context', 'investigate_incident', { aliasId: state.aliasRef.id, senderId: state.senderRef.id });
      calls.push(...inv.calls); findings = inv.out; evidence.push(`sender:${state.senderRef.id}`, ...((inv.out.evidence as { signal: string }[]) ?? []).map((e) => `signal:${e.signal}`));
      const list = await db.withUser(state.userId, (c) => senders.forAlias(c, state.userId, state.aliasRef!.id));
      remote = { ...remote, senderBlocked: list.find((s) => s.id === state.senderRef!.id)?.blocked };
    }
    if (state.aliasRef) {
      try {
        const st = await call<{ remote: { enabled: boolean } | null }>(state, 'retrieve_context', 'get_alias_status', { aliasId: state.aliasRef.id, fresh: true });
        calls.push(...st.calls); if (st.out.remote) remote = { ...remote, aliasEnabled: st.out.remote.enabled };
      } catch { remote = { ...remote, providerReachable: false }; }
    }
    if (intent === 'investigate_sender' && state.aliasRef && !state.senderRef) {
      const list = await call<ReturnType<typeof publicSender>[]>(state, 'retrieve_context', 'get_alias_sender_events', { aliasId: state.aliasRef.id, fresh: false });
      calls.push(...list.calls);
      findings = { alias: state.aliasRef, senders: list.out, unexpected: list.out.filter((s) => s.classification === 'unexpected') };
    }
    if (['review_accounts', 'cleanup_dormant', 'summarize_history', 'explain_audit'].includes(intent)) findings = await aggregate(state, intent, calls);
    return { ...stamp('retrieve_context'), toolCalls: calls, findings, evidenceRefs: evidence, remoteState: remote };
  }

  async function aggregate(state: State, intent: Intent, calls: ToolCall[]): Promise<Record<string, unknown>> {
    const list = await call<ReturnType<typeof publicAlias>[]>(state, 'retrieve_context', 'list_user_aliases', {});
    calls.push(...list.calls);
    const now = Date.now();
    if (intent === 'review_accounts') {
      const needs = list.out.filter((a) => a.credentialStatus !== 'vault-encrypted');
      return { kind: 'review_accounts', accounts: needs.map((a) => ({ ...a, reason: a.credentialStatus === 'generated-not-stored' ? 'A strong password was generated but not kept in the vault, so NEARAuth cannot confirm it is still in use.' : a.credentialStatus === 'none' ? 'No NEARAuth-generated password: it may be reused or weak.' : 'Credential status unknown.' })),
        checklist: ['Open the service\'s own website (not an email link) and sign in.', 'Change the password to a newly generated one and save it in the vault.', 'Sign out other sessions; turn on two-factor authentication if offered.'],
        note: 'NEARAuth cannot change passwords on other services; no change is reported until you confirm it.' };
    }
    if (intent === 'cleanup_dormant') {
      const days = (d: unknown) => (d ? Math.floor((now - new Date(d as string).getTime()) / 86400000) : null);
      const dormant = list.out.map((a) => ({ ...a, idleDays: days(a.lastActivity) ?? days(a.created) })).filter((a) => (a.idleDays ?? 0) >= 90);
      return { kind: 'cleanup_dormant', dormant, note: 'Request deletion on each service\'s own site, then pause its alias. NEARAuth will not delete third-party accounts.' };
    }
    const rows = await db.withUser(state.userId, async (c) => ({
      workflows: (await c.query(`SELECT status, intent, summary, created_at FROM privacy_workflows WHERE user_id = $1 AND created_at > now() - interval '31 days' ORDER BY created_at DESC LIMIT 100`, [state.userId])).rows,
      receipts: (await c.query(`SELECT id, status, mode, sanitized_input, created_at FROM tool_receipts WHERE user_id = $1 AND created_at > now() - interval '31 days' ORDER BY created_at DESC LIMIT 100`, [state.userId])).rows,
      unexpected: Number((await c.query(`SELECT count(*)::int n FROM sender_observations WHERE user_id = $1 AND classification = 'unexpected'`, [state.userId])).rows[0].n),
      blocked: Number((await c.query(`SELECT count(*)::int n FROM sender_observations WHERE user_id = $1 AND blocked`, [state.userId])).rows[0].n),
      audit: (await c.query(`SELECT id, kind, label, created_at FROM audit_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [state.userId])).rows,
    }));
    if (intent === 'explain_audit') {
      const q = state.requestText.toLowerCase();
      const words = q.split(/\W+/).filter((w) => w.length > 3 && !['audit', 'show', 'what', 'have', 'with', 'receipt', 'receipts', 'history'].includes(w));
      const matches = rows.audit.filter((e) => !words.length || words.some((w) => String(e.label).toLowerCase().includes(w)));
      return { kind: 'explain_audit', events: matches.slice(0, 20), receipts: rows.receipts.slice(0, 20), matchedOn: words };
    }
    return { kind: 'summarize_history', period: 'last 31 days', aliases: list.out.length, unexpectedSenders: rows.unexpected, blockedSenders: rows.blocked,
      actions: rows.receipts.length, verified: rows.receipts.filter((r) => r.status === 'verified').length,
      byStatus: rows.workflows.reduce((m: Record<string, number>, w) => ({ ...m, [w.status]: (m[w.status] ?? 0) + 1 }), {}), recent: rows.workflows.slice(0, 10) };
  }

  /* 5 ─ Propose actions (least disruptive first) */
  async function propose_actions(state: State): Promise<Update> {
    const spec = ACTION_FOR[state.intent!]!;
    const calls: ToolCall[] = [];
    const input = spec.sender ? { aliasId: state.aliasRef!.id, senderId: state.senderRef!.id } : { aliasId: state.aliasRef!.id };
    const primary = await call<ProposalView>(state, 'propose_actions', spec.tool, input);
    calls.push(...primary.calls);
    const candidates = [primary.out];
    if (state.intent === 'unsubscribe') {
      const alt = await call<ProposalView>(state, 'propose_actions', 'propose_sender_block', input);
      calls.push(...alt.calls); candidates.push(alt.out);
    } else if (state.intent === 'block_sender') {
      const broader = await call<ProposalView>(state, 'propose_actions', 'propose_alias_pause', { aliasId: state.aliasRef!.id });
      calls.push(...broader.calls); candidates.push(broader.out); // shown as the more disruptive option, not selected
    }
    return { ...stamp('propose_actions'), toolCalls: calls, candidateActions: candidates, selectedAction: primary.out };
  }

  /* 6 ─ Evaluate policy (deterministic; no model involved) */
  async function policyFor(state: State, action: ActionKind) {
    return db.withUser(state.userId, async (c) => {
      const user = (await users.get(c, state.userId))!;
      const alias = state.aliasRef ? await aliases.get(c, state.userId, state.aliasRef.id) : null;
      const sender = state.senderRef ? await senders.get(c, state.userId, state.senderRef.id) : null;
      return evaluatePolicy({ action, user, sessionUserId: state.userId, alias, sender, provider, remote: state.remoteState?.providerReachable === false ? null : state.remoteState,
        standing: await policies.list(c, state.userId), writesLastHour: await workflows.recentWrites(c, state.userId) });
    });
  }
  async function evaluate_policy(state: State): Promise<Update> {
    const decision = await policyFor(state, state.selectedAction!.action as ActionKind);
    return { ...stamp('evaluate_policy'), policyResult: decision, riskTier: decision.riskTier,
      approvalStatus: decision.outcome === 'allow' ? (decision.autoApprovedBy ? 'auto_approved' : 'pending') : 'not_required' };
  }

  /* 7 ─ Request approval (human-in-the-loop interrupt) */
  async function request_approval(state: State): Promise<Update> {
    const p = state.selectedAction!;
    const apr = await db.withUser(state.userId, (c) => approvals.getOrCreate(c, { userId: state.userId, threadId: state.threadId, proposalId: p.id, actionHash: p.actionHash }));
    await persist(state, { status: 'awaiting_approval', summary: `Waiting for your approval: ${p.title}.` });
    const resume = interrupt({
      type: 'approval', approvalId: apr.id, actionHash: p.actionHash, expiresAt: new Date(apr.expires_at).toISOString(),
      action: p.action, title: p.title, effect: p.effect, target: p.target, provider: { id: provider.id, label: provider.label, mode: provider.mode },
      risk: state.riskTier, reversible: p.reversible, undo: p.undo, warnings: state.policyResult?.warnings ?? [], requiresRecentAuth: state.policyResult?.requiresRecentAuth ?? false,
      rules: state.policyResult?.rules ?? [], alternatives: state.candidateActions.filter((x) => x.id !== p.id).map((x) => ({ action: x.action, title: x.title, effect: x.effect })),
    }) as { approvalId: string };
    // The resume value only says "look again"; the database row is the source of truth for the decision.
    const row = await db.withUser(state.userId, (c) => approvals.get(c, state.userId, resume?.approvalId ?? apr.id));
    let status = row?.id === apr.id ? row.status : 'pending';
    if (status === 'pending' && row && new Date(row.expires_at).getTime() <= Date.now()) {
      await db.withUser(state.userId, (c) => c.query(`UPDATE action_approvals SET status = 'expired' WHERE id = $1 AND status = 'pending'`, [apr.id]));
      status = 'expired';
    }
    return { ...stamp('request_approval'), approvalId: apr.id,
      approvalStatus: status === 'approved' || status === 'consumed' ? 'approved' : status === 'expired' ? 'expired' : status === 'declined' ? 'declined' : 'pending' };
  }

  /* 8 ─ Revalidate & execute */
  async function revalidate_execute(state: State): Promise<Update> {
    const p = state.selectedAction!;
    const calls: ToolCall[] = [];
    try {
      let resumed = false; // true when a previous run of this node consumed the approval and then crashed
      if (state.approvalStatus === 'approved') {
        resumed = 'resumed' === await db.withUser(state.userId, (c) => approvals.consume(c, { userId: state.userId, threadId: state.threadId, approvalId: state.approvalId!, actionHash: p.actionHash }));
      }
      // Fresh provider read + policy re-run: ownership, sender, state may have changed while waiting.
      let remote = { providerReachable: true } as State['remoteState'];
      try {
        const st = await call<{ remote: { enabled: boolean; emailMatches: boolean } | null }>(state, 'revalidate_execute', 'get_alias_status', { aliasId: p.aliasId, fresh: true });
        calls.push(...st.calls);
        if (st.out.remote && !st.out.remote.emailMatches) throw new AgentError('target_changed', 'The provider now reports a different address for this alias', 409);
        remote = { ...remote!, aliasEnabled: st.out.remote?.enabled };
        if (p.senderId) {
          const ev = await call<ReturnType<typeof publicSender>[]>(state, 'revalidate_execute', 'get_alias_sender_events', { aliasId: p.aliasId, fresh: true });
          calls.push(...ev.calls);
          remote = { ...remote!, senderBlocked: ev.out.find((s) => s.id === p.senderId)?.blocked };
        }
      } catch (e) { if ((e as AgentError).code === 'target_changed') throw e; remote = { providerReachable: false }; }
      const again = await policyFor({ ...state, remoteState: remote }, p.action as ActionKind);
      if (again.outcome === 'already_done' && !resumed) {
        return { ...stamp('revalidate_execute'), toolCalls: calls, policyResult: again, executionReceipt: null, status: 'completed' };
      }
      if (again.outcome !== 'allow' && !(resumed && again.outcome === 'already_done')) throw new AgentError('policy_changed', 'A policy check failed on revalidation: ' + again.rules.filter((r) => !r.passed).map((r) => r.detail).join('; '), 409);
      if (state.approvalStatus === 'auto_approved' && !again.autoApprovedBy) throw new AgentError('policy_expired', 'The standing policy no longer covers this action', 409);
      if (!remote?.providerReachable) throw new AgentError('provider_unavailable', `${provider.label} could not be reached, so nothing was changed`, 503);

      await persist(state, { status: 'running' });
      const grant = { threadId: state.threadId, proposalId: p.id, actionHash: p.actionHash, approvalId: state.approvalId, policyId: again.autoApprovedBy };
      const ex = await call<{ receiptId: string; status: string; attempts: number; duplicate?: boolean; errorCode?: string }>(state, 'revalidate_execute', 'execute_approved_action', { proposalId: p.id, actionHash: p.actionHash }, grant);
      calls.push(...ex.calls);
      return { ...stamp('revalidate_execute'), toolCalls: calls, executionReceipt: ex.out, errorCode: ex.out.errorCode ?? null,
        status: ex.out.status === 'failed' ? 'failed' : ex.out.status === 'verified' ? 'verified' : 'requested' };
    } catch (e) {
      if (!(e instanceof AgentError)) throw e; // unexpected failure: stop here; the checkpoint lets recover() resume safely
      return { ...stamp('revalidate_execute'), toolCalls: calls, errorCode: e.code, explanation: e.message, status: 'denied' };
    }
  }

  /* 9 ─ Verify outcome */
  async function verify_outcome(state: State): Promise<Update> {
    const p = state.selectedAction!;
    const grant = { threadId: state.threadId, proposalId: p.id, actionHash: p.actionHash, approvalId: state.approvalId, policyId: state.policyResult?.autoApprovedBy ?? null };
    try {
      const v = await call<{ status: string; observed?: Record<string, unknown>; detail?: string }>(state, 'verify_outcome', 'verify_action', { receiptId: state.executionReceipt!.receiptId, proposalId: p.id }, grant);
      return { ...stamp('verify_outcome'), toolCalls: v.calls, verificationResult: v.out, status: v.out.status === 'verified' ? 'verified' : v.out.status === 'failed' ? 'failed' : 'requested' };
    } catch (e) {
      return { ...stamp('verify_outcome'), verificationResult: { status: 'requested', detail: 'Submitted, but the provider could not be re-read to confirm: ' + ((e as AgentError).code ?? 'error') }, status: 'requested' };
    }
  }

  /* Terminal routes */
  async function explain_limitation(state: State): Promise<Update> {
    let msg = state.explanation;
    if (state.intent === 'unknown' || !state.intent) msg = 'I can investigate senders, block or unblock one sender, pause or resume an alias, review accounts for password rotation, find unused aliases, and summarize or search your history. I could not match your request to one of those.';
    else if (state.policyResult?.outcome === 'unsupported') {
      const failed = state.policyResult.rules.filter((r) => !r.passed).map((r) => r.detail).join(' ');
      const alt = state.candidateActions.find((a) => a.action === state.policyResult?.alternative);
      msg = `${INTENT_LABELS[state.intent]} is not available here. ${failed}${alt ? ` Instead I can: ${alt.title.toLowerCase()} — ${alt.effect}` : ''}`;
      if (state.intent === 'unsubscribe') msg += ' Ask me to "block this sender" to do that.';
      if (state.selectedAction?.action === 'credential_rotation') msg = 'NEARAuth cannot change passwords on other services. Here is a checklist instead.';
    }
    return { ...stamp('explain_limitation'), status: 'unsupported', explanation: msg || 'That cannot be done here.' };
  }
  async function deny(state: State): Promise<Update> {
    const failed = state.policyResult?.rules.filter((r) => !r.passed).map((r) => `${r.id}: ${r.detail}`) ?? [];
    return { ...stamp('deny'), status: 'denied', explanation: state.explanation || (failed.length ? `Not allowed — ${failed.join('; ')}.` : 'Not allowed.') };
  }
  async function return_findings(state: State): Promise<Update> {
    const f = state.findings ?? {};
    let msg = 'Here is what I found.';
    if (state.intent === 'investigate_sender' && f.classification) msg = `${f.summary} Confidence: ${f.confidence}. ${f.caveat}`;
    if (state.intent === 'investigate_sender' && f.senders) msg = `${(f.unexpected as unknown[]).length} unexpected sender(s) out of ${(f.senders as unknown[]).length} seen on your ${state.aliasRef?.service} alias.`;
    if (f.kind === 'review_accounts') msg = `${(f.accounts as unknown[]).length} account(s) may need a password review. ${f.note}`;
    if (f.kind === 'cleanup_dormant') msg = `${(f.dormant as unknown[]).length} alias(es) have been idle for 90 days or more. ${f.note}`;
    if (f.kind === 'summarize_history') msg = `In the ${f.period}: ${f.actions} protective action(s), ${f.verified} verified; ${f.unexpectedSenders} unexpected sender(s) observed, ${f.blockedSenders} blocked, across ${f.aliases} alias(es).`;
    if (f.kind === 'explain_audit') msg = `${(f.events as unknown[]).length} matching audit event(s).`;
    return { ...stamp('return_findings'), status: 'completed', explanation: msg };
  }
  async function record_decline(state: State): Promise<Update> {
    return state.approvalStatus === 'expired'
      ? { ...stamp('record_decline'), status: 'expired', explanation: 'The approval expired, so nothing was changed. Ask again to get a fresh approval.' }
      : { ...stamp('record_decline'), status: 'declined', explanation: 'You declined, so nothing was changed.' };
  }
  async function already_done(state: State): Promise<Update> {
    const dup = state.executionReceipt?.duplicate;
    return { ...stamp('already_done'), status: 'completed', explanation: dup ? 'This exact action already ran; returning its existing result.' : 'Nothing to do: the provider already reports the requested state.' };
  }

  /* 10 ─ Record & explain */
  async function finalize(state: State): Promise<Update> {
    const p = state.selectedAction;
    let explanation = state.explanation;
    if (state.status === 'verified') explanation = `${p!.title} — done and verified at ${provider.id}. ${p!.effect}${p!.undo ? ' You can undo this from Action History.' : ''}`;
    else if (state.status === 'requested') explanation = `${p!.title} — submitted to ${provider.id}; ${state.verificationResult?.detail ?? 'not yet verified.'}`;
    else if (state.status === 'failed') explanation = `${p?.title ?? 'The action'} failed (${state.errorCode ?? 'error'}). ${state.verificationResult?.status === 'failed' ? 'The provider does not report the change.' : 'Retries stopped after the limit; nothing further will happen automatically.'}`;
    const label = `${INTENT_LABELS[state.intent ?? 'unknown']}${state.aliasRef ? ' · ' + state.aliasRef.service + ' ' + state.aliasRef.masked : ''}${state.senderRef ? ' · ' + state.senderRef.domain : ''} → ${state.status}${provider.mode === 'simulation' && state.executionReceipt ? ' (simulation)' : ''}`;
    const evt = await db.withUser(state.userId, async (c) => {
      const e = await recordAudit(c, state.userId, state.threadId, 'Privacy agent', label);
      if (state.executionReceipt?.receiptId) await c.query('UPDATE tool_receipts SET commitment = $3 WHERE user_id = $1 AND id = $2', [state.userId, state.executionReceipt.receiptId, e.commitment]);
      await workflows.update(c, state.userId, state.threadId, { status: state.status, summary: explanation, path: [...state.path, 'finalize'] });
      return e;
    });
    if (state.status === 'verified' && p?.action === 'block_sender' && state.findings?.summary) {
      const user = await db.withUser(state.userId, (c) => users.get(c, state.userId));
      await memory.addIncidentSummary(state.userId, state.senderRef!.id, `Blocked ${state.senderRef!.domain} on the ${state.aliasRef!.service} alias: ${state.findings.summary}`, !!user?.memory_opt_out).catch(() => null);
    }
    return { ...stamp('finalize'), explanation, evidenceRefs: [...state.evidenceRefs, `audit:${evt.id}`] };
  }

  /* Wiring — conditional routes mirror spec.ts EDGES */
  const g = new StateGraph(PrivacyAgentState)
    .addNode('parse_intent', parse_intent).addNode('authorize', authorize).addNode('resolve_target', resolve_target)
    .addNode('select_target', select_target).addNode('retrieve_context', retrieve_context).addNode('propose_actions', propose_actions)
    .addNode('evaluate_policy', evaluate_policy).addNode('request_approval', request_approval).addNode('revalidate_execute', revalidate_execute)
    .addNode('verify_outcome', verify_outcome).addNode('finalize', finalize).addNode('explain_limitation', explain_limitation)
    .addNode('deny', deny).addNode('return_findings', return_findings).addNode('record_decline', record_decline).addNode('already_done', already_done)
    .addEdge(START, 'parse_intent')
    .addConditionalEdges('parse_intent', (s: State) => (s.intent && s.intent !== 'unknown' ? 'authorize' : 'explain_limitation'), ['authorize', 'explain_limitation'])
    .addConditionalEdges('authorize', (s: State) => (s.errorCode ? 'deny' : 'resolve_target'), ['deny', 'resolve_target'])
    .addConditionalEdges('resolve_target', (s: State) => (s.errorCode === 'not_owned' ? 'deny' : s.errorCode ? 'explain_limitation' : s.candidates.length ? 'select_target' : 'retrieve_context'),
      ['deny', 'explain_limitation', 'select_target', 'retrieve_context'])
    .addConditionalEdges('select_target', (s: State) => (s.errorCode ? 'deny' : 'resolve_target'), ['deny', 'resolve_target'])
    .addConditionalEdges('retrieve_context', (s: State) => (READ_INTENTS.includes(s.intent!) ? 'return_findings' : 'propose_actions'), ['return_findings', 'propose_actions'])
    .addEdge('propose_actions', 'evaluate_policy')
    .addConditionalEdges('evaluate_policy', (s: State) => {
      const o = s.policyResult!.outcome;
      return o === 'deny' ? 'deny' : o === 'unsupported' ? 'explain_limitation' : o === 'already_done' ? 'already_done' : s.approvalStatus === 'auto_approved' ? 'revalidate_execute' : 'request_approval';
    }, ['deny', 'explain_limitation', 'already_done', 'revalidate_execute', 'request_approval'])
    .addConditionalEdges('request_approval', (s: State) => (s.approvalStatus === 'approved' ? 'revalidate_execute' : 'record_decline'), ['revalidate_execute', 'record_decline'])
    .addConditionalEdges('revalidate_execute', (s: State) => (s.status === 'denied' ? 'deny' : s.status === 'completed' ? 'already_done'
      : s.executionReceipt?.duplicate && s.executionReceipt.status !== 'running' && s.executionReceipt.status !== 'requested' ? 'already_done'
      : s.status === 'failed' ? 'finalize' : 'verify_outcome'), ['deny', 'already_done', 'finalize', 'verify_outcome'])
    .addEdge('verify_outcome', 'finalize')
    .addEdge('explain_limitation', 'finalize').addEdge('deny', 'finalize').addEdge('return_findings', 'finalize')
    .addEdge('record_decline', 'finalize').addEdge('already_done', 'finalize').addEdge('finalize', END);

  void WRITE_INTENTS;
  return g.compile({ checkpointer });
}
