import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { approval, aliasIdOf, demoUser, freshDb, makeService, senderId, testConfig, uid } from './helpers.js';
import type { AgentService } from '../src/service.js';
import type { MockProvider } from '../src/providers/mock.js';
import { createSimpleLoginAdapter } from '../src/providers/simplelogin.js';
import { mintGrant } from '../src/tools/registry.js';
import { OllamaIntentModel } from '../src/llm.js';
import { assertSafeForEmbedding } from '../src/memory.js';
import { createApi } from '../src/server.js';

const require = createRequire(import.meta.url);
let svc: AgentService, mock: MockProvider;
before(async () => { ({ svc, provider: mock } = await makeService({ config: { approvalTtlMs: 60_000 } })); });
after(async () => { await svc.close(); });

const startBlock = (s: Parameters<AgentService['start']>[0]) => svc.start(s, { text: 'Stop promo@brightline-ads.com from emailing my Nova Market alias' });

test('replayed approval is refused; the action runs once', async () => {
  const { s } = await demoUser(svc);
  const w = await startBlock(s);
  const a = approval(w);
  await svc.decide(s, w.threadId, { approvalId: a.approvalId, actionHash: a.actionHash, decision: 'approve' });
  const writes = mock.writes().length;
  await assert.rejects(svc.decide(s, w.threadId, { approvalId: a.approvalId, actionHash: a.actionHash, decision: 'approve' }), /not waiting|already/);
  assert.equal(mock.writes().length, writes);
});

test('approval must echo the displayed action hash', async () => {
  const { s } = await demoUser(svc);
  const w = await startBlock(s);
  const a = approval(w);
  await assert.rejects(svc.decide(s, w.threadId, { approvalId: a.approvalId, actionHash: 'f'.repeat(64), decision: 'approve' }), (e: { code: string }) => e.code === 'approval_mismatch');
});

test('expired approval: nothing runs, workflow ends as expired', async () => {
  const { svc: quick, provider } = await makeService({ config: { approvalTtlMs: 30 } });
  try {
    const { s } = await demoUser(quick);
    const w = await quick.start(s, { text: 'Stop promo@brightline-ads.com from emailing my Nova Market alias' });
    await new Promise((r) => setTimeout(r, 60));
    const a = approval(w);
    const done = await quick.decide(s, w.threadId, { approvalId: a.approvalId, actionHash: a.actionHash, decision: 'approve' });
    assert.equal(done.status, 'expired');
    assert.equal(provider.writes().length, 0);
  } finally { await quick.close(); }
});

test('target changes after approval is shown: revalidation aborts', async () => {
  const { s, user } = await demoUser(svc);
  const w = await startBlock(s);
  const a = approval(w);
  // The alias is re-pointed (e.g. re-synced to a different remote alias) while the approval is pending.
  await svc.db.withUser(user, (c) => c.query("UPDATE user_aliases SET remote_id = $2 WHERE id = $1", [aliasIdOf(user, 'nova'), `${user}-102`]));
  const before = mock.writes().length;
  const done = await svc.decide(s, w.threadId, { approvalId: a.approvalId, actionHash: a.actionHash, decision: 'approve' });
  assert.equal(done.status, 'denied');
  assert.equal(done.errorCode, 'target_changed');
  assert.equal(mock.writes().length, before);
});

test('cross-user access is impossible through the service and at the database', async () => {
  const alice = await demoUser(svc), bob = await demoUser(svc);
  const w = await startBlock(alice.s);
  await assert.rejects(svc.snapshot(bob.s, w.threadId), (e: { code: string }) => e.code === 'not_found');
  const a = approval(w);
  await assert.rejects(svc.decide(bob.s, w.threadId, { approvalId: a.approvalId, actionHash: a.actionHash, decision: 'approve' }), (e: { code: string }) => e.code === 'not_found');
  const sid = await senderId(svc, alice.s, 'promo@brightline-ads.com');
  const stolen = await svc.start(bob.s, { intent: 'block_sender', aliasId: aliasIdOf(alice.user, 'nova'), senderId: sid });
  assert.equal(stolen.status, 'denied', 'another user\'s alias id resolves to nothing');
  const rows = await svc.db.withUser(bob.user, async (c) => (await c.query('SELECT count(*)::int n FROM user_aliases WHERE user_id = $1', [alice.user])).rows[0].n);
  assert.equal(rows, 0, 'row-level security hides other users even with an explicit predicate');
  await assert.rejects(svc.db.withUser(bob.user, (c) => c.query(`UPDATE tool_receipts SET status = 'verified' WHERE user_id = $1 RETURNING id`, [alice.user]).then((r) => { if (r.rowCount) throw new Error('leak'); throw new Error('no rows'); })), /no rows/);
});

test('model and callers cannot reach privileged tools', async () => {
  const { s, user } = await demoUser(svc);
  const w = await startBlock(s);
  const p = w.selectedAction!;
  const input = { proposalId: p.id, actionHash: p.actionHash };
  await assert.rejects(svc.tools.invoke('execute_approved_action', input, { userId: user, caller: { type: 'llm', model: 'evil' }, threadId: w.threadId }), (e: { code: string }) => e.code === 'tool_forbidden');
  await assert.rejects(svc.tools.invoke('execute_approved_action', input, { userId: user, caller: { type: 'api', sessionId: 'x' }, threadId: w.threadId }), (e: { code: string }) => e.code === 'tool_forbidden');
  await assert.rejects(svc.tools.invoke('execute_approved_action', input, { userId: user, caller: { type: 'node', node: 'x' }, threadId: w.threadId }), (e: { code: string }) => e.code === 'grant_required');
  const fake = { threadId: w.threadId, proposalId: p.id, actionHash: p.actionHash, approvalId: null, policyId: null };
  await assert.rejects(svc.tools.invoke('execute_approved_action', input, { userId: user, caller: { type: 'node', node: 'x' }, threadId: w.threadId, grant: fake }), (e: { code: string }) => e.code === 'grant_required');
  const wrong = mintGrant({ ...fake, actionHash: 'a'.repeat(64) });
  await assert.rejects(svc.tools.invoke('execute_approved_action', input, { userId: user, caller: { type: 'node', node: 'x' }, threadId: w.threadId, grant: wrong }), (e: { code: string }) => e.code === 'grant_mismatch');
  await assert.rejects(svc.tools.invoke('approve_action', { threadId: w.threadId, approvalId: approval(w).approvalId, actionHash: p.actionHash }, { userId: user, caller: { type: 'llm', model: 'evil' } }), (e: { code: string }) => e.code === 'tool_forbidden');
  const names = svc.tools.list().map((t) => t.name).join(' ');
  assert.doesNotMatch(names, /http|fetch|shell|exec_cmd|browser|vault|credential_get|password_get/, 'no generic or credential tools exist');
});

test('a model reply naming a tool is rejected; injected sender text is treated as data', async () => {
  const evil: typeof fetch = async () => new Response(JSON.stringify({ message: { content: JSON.stringify({ intent: 'block_sender', tool: 'execute_approved_action' }) } }));
  const model = new OllamaIntentModel('http://127.0.0.1:1', 'x', 1000, evil);
  assert.equal(await model.classify('do the thing'), null, 'extra keys fail the strict schema');
  const good: typeof fetch = async () => new Response(JSON.stringify({ message: { content: '{"intent":"block_sender"}' } }));
  assert.equal(await new OllamaIntentModel('http://127.0.0.1:1', 'x', 1000, good).classify('hm'), 'block_sender');

  // Demo data includes a sender display name carrying instructions. Investigating it changes nothing.
  const { s } = await demoUser(svc);
  const before = mock.writes().length;
  const w = await svc.start(s, { text: 'Investigate promo@brightline-ads.com on my Nova Market alias' });
  assert.equal(w.status, 'completed');
  assert.equal(mock.writes().length, before);
  assert.ok(!w.path.includes('revalidate_execute'));
});

test('local model offline: deterministic rules still work', async () => {
  const { svc: withModel } = await makeService({ intentModel: new OllamaIntentModel('http://127.0.0.1:9', 'llama3.2:3b', 500) });
  try {
    const { s } = await demoUser(withModel);
    const w = await withModel.start(s, { text: 'Stop promo@brightline-ads.com from emailing my Nova Market alias' });
    assert.equal(w.status, 'awaiting_approval', 'rules matched; model not needed');
    const u = await withModel.start(s, { text: 'hmm, something about my stuff' });
    assert.equal(u.status, 'unsupported');
    const call = u.toolCalls.find((t) => t.tool === 'intent_model')!;
    assert.equal(call.status, 'error');
    assert.match(call.error!, /using rules/);
  } finally { await withModel.close(); }
});

test('provider unavailable: transient errors retried within bounds; outages change nothing', async () => {
  const { s } = await demoUser(svc);
  let w = await startBlock(s), a = approval(w);
  // The first two write attempts fail transiently (HTTP 429); the third succeeds.
  const realSet = mock.setSenderBlocked.bind(mock);
  let calls = 0;
  mock.setSenderBlocked = async (...args) => { calls++; if (calls <= 2) { const { ProviderError } = await import('../src/providers/types.js'); throw new ProviderError('rate_limited', 'slow down', true); } return realSet(...args); };
  let done = await svc.decide(s, w.threadId, { approvalId: a.approvalId, actionHash: a.actionHash, decision: 'approve' });
  assert.equal(done.status, 'verified');
  assert.equal(done.receipts[0].attempts, 3);

  mock.setSenderBlocked = async () => { const { ProviderError } = await import('../src/providers/types.js'); throw new ProviderError('forbidden', 'plan limit', false); };
  const other = await demoUser(svc);
  w = await svc.start(other.s, { text: 'Block deals@datavista-leads.com on my Chess Forum alias' }); a = approval(w);
  done = await svc.decide(other.s, w.threadId, { approvalId: a.approvalId, actionHash: a.actionHash, decision: 'approve' });
  assert.equal(done.status, 'failed');
  assert.equal(done.receipts[0].attempts, 1, 'non-transient errors are not retried');
  mock.setSenderBlocked = realSet;

  const third = await demoUser(svc);
  w = await svc.start(third.s, { text: 'Block deals@datavista-leads.com on my Chess Forum alias' }); a = approval(w);
  mock.offline = true;
  try {
    done = await svc.decide(third.s, w.threadId, { approvalId: a.approvalId, actionHash: a.actionHash, decision: 'approve' });
    assert.equal(done.status, 'denied');
    assert.equal(done.errorCode, 'provider_unavailable');
  } finally { mock.offline = false; }
});

test('checkpoint resumption after restart, and crash mid-execution never double-applies a toggle', async () => {
  const db = await freshDb();
  const first = await makeService({ db });
  const { s, user, token } = await demoUser(first.svc);
  const w = await first.svc.start(s, { text: 'Stop promo@brightline-ads.com from emailing my Nova Market alias' });
  const a = approval(w);
  // "Restart": a new service, graph, checkpointer and provider over the same database. The mock is re-hydrated.
  const { svc: second, provider: mock2 } = await makeService({ db });
  const s2 = await second.authenticate(token);
  let crashed = false;
  mock2.afterWrite = () => { if (!crashed) { crashed = true; throw new Error('simulated crash after the provider applied the change'); } };
  await assert.rejects(second.decide(s2, w.threadId, { approvalId: a.approvalId, actionHash: a.actionHash, decision: 'approve' }), /simulated crash/);
  const contact = () => mock2.aliases.get(`${user}-101`)!.contacts.find((c) => c.address === 'promo@brightline-ads.com')!;
  assert.equal(contact().blocked, true, 'the provider applied the change before the crash');
  mock2.afterWrite = null;
  const recovered = await second.recover(s2, w.threadId);
  assert.equal(recovered.status, 'verified');
  assert.equal(contact().blocked, true, 'resume did not toggle it back');
  assert.equal(recovered.receipts.length, 1, 'one receipt for one idempotency key');
  await second.close();
  await first.svc.close().catch(() => {});
});

test('no secrets in checkpoints, receipts or embeddings (real SimpleLogin adapter against a local mock server)', async () => {
  const mockSl = require('../../tests/e2e/mock-simplelogin.js') as { start(port: number, key: string): Promise<{ db: { aliases: Record<string, unknown>; contacts: Record<string, { contact: string; block_forward: boolean }[]>; receive(id: number, a: string): void }; close(): void }> };
  const KEY = 'SL_TEST_KEY_do_not_log_' + 'x'.repeat(20);
  const server = await mockSl.start(9198, KEY);
  const adapter = createSimpleLoginAdapter({ apiKey: KEY, baseUrl: 'http://localhost:9198' });
  const { svc: real } = await makeService({ provider: adapter });
  try {
    // create the remote alias + a third-party sender at the mock SimpleLogin
    const created = await (await fetch('http://localhost:9198/api/alias/random/new', { method: 'POST', headers: { Authentication: KEY, 'Content-Type': 'application/json' }, body: '{}' })).json() as { id: number; email: string };
    server.db.receive(created.id, 'promo@spam-broker.com');
    const user = uid('sl');
    const { token } = await real.issueSession(user, user);
    const s = await real.authenticate(token);
    const sync = await real.sync(s, { aliases: [{ alias: created.email, service: 'Nova Market', domain: 'novamarket.com', provider: 'simplelogin', remoteId: String(created.id) }],
      observations: [{ alias: created.email, sender: 'promo@spam-broker.com' }] });
    assert.equal(sync.accepted, 1);
    const bogus = await real.sync(s, { aliases: [{ alias: 'not-mine@simplelogin.test', service: 'X', domain: 'x.com', provider: 'simplelogin', remoteId: String(created.id) }] });
    assert.equal(bogus.rejected, 1, 'a real provider must confirm the alias address before it is accepted');

    const w = await real.start(s, { text: 'Block promo@spam-broker.com on my Nova Market alias' });
    assert.equal(w.mode, 'real');
    const a = approval(w);
    const done = await real.decide(s, w.threadId, { approvalId: a.approvalId, actionHash: a.actionHash, decision: 'approve' });
    assert.equal(done.status, 'verified');
    assert.equal(server.db.contacts[created.id][0].block_forward, true, 'blocked at the (mock) provider');

    const dump = await real.db.withSystem(async (c) => {
      await c.query('RESET ROLE');
      const parts = [];
      for (const t of ['checkpoints', 'checkpoint_blobs', 'checkpoint_writes', 'tool_receipts', 'action_proposals', 'privacy_workflows', 'audit_events', 'privacy_embeddings', 'agent_sessions']) {
        parts.push(JSON.stringify((await c.query(`SELECT * FROM ${t}`)).rows));
      }
      return parts.join('\n');
    });
    assert.ok(!dump.includes(KEY), 'provider API key never stored');
    assert.ok(!dump.includes(token), 'session token never stored (only its hash)');
  } finally { await real.close(); server.close(); }
  assert.throws(() => assertSafeForEmbedding('my password: hunter2hunter2'), /secret/);
  assert.throws(() => assertSafeForEmbedding('key ' + 'A'.repeat(40)), /secret/);
  assert.doesNotThrow(() => assertSafeForEmbedding('Blocked spam-broker.com on the Nova Market alias'));
});

test('real provider mode refuses to start on a non-loopback address', async () => {
  const { loadConfig } = await import('../src/config.js');
  assert.throws(() => loadConfig({ NEARAUTH_PROVIDER: 'simplelogin', SIMPLELOGIN_API_KEY: 'k', NEARAUTH_AGENT_HOST: '0.0.0.0', NEARAUTH_DATA_DIR: '/tmp/x' } as NodeJS.ProcessEnv), /loopback/);
  assert.throws(() => loadConfig({ NEARAUTH_PROVIDER: 'simplelogin', NEARAUTH_DATA_DIR: '/tmp/x' } as NodeJS.ProcessEnv), /SIMPLELOGIN_API_KEY/);
});

test('HTTP API: authentication, origin allow-list, body limits, no cookies', async () => {
  const cfg = testConfig();
  const server = createApi(svc, cfg).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const { token } = await demoUser(svc);
    assert.equal((await fetch(`${base}/v1/health`)).status, 200);
    assert.equal((await fetch(`${base}/v1/aliases`)).status, 401);
    assert.equal((await fetch(`${base}/v1/aliases`, { headers: { Authorization: 'Bearer ' + 'x'.repeat(43) } })).status, 401);
    const evil = await fetch(`${base}/v1/aliases`, { headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
    const ok = await fetch(`${base}/v1/aliases`, { headers: { Authorization: `Bearer ${token}`, Origin: 'https://pauloes-btechs.github.io' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://pauloes-btechs.github.io');
    assert.equal(ok.headers.get('set-cookie'), null);
    const big = await fetch(`${base}/v1/workflows`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(70000) }) });
    assert.equal(big.status, 413);
    const form = await fetch(`${base}/v1/workflows`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: 'hi' });
    assert.equal(form.status, 415, 'simple cross-site form posts are refused');
    const w = await (await fetch(`${base}/v1/workflows`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Block deals@datavista-leads.com on my Chess Forum alias' }) })).json() as { status: string };
    assert.equal(w.status, 'awaiting_approval');
  } finally { server.close(); }
});

test('retention deletes workflows older than the user\'s setting and keeps newer ones', async () => {
  const { s } = await demoUser(svc);
  const old = await startBlock(s), fresh = await startBlock(s);
  await svc.updateSettings(s, { retentionDays: 30 });
  await svc.db.withUser(s.userId, (c) => c.query(`UPDATE privacy_workflows SET created_at = now() - interval '31 days' WHERE thread_id = $1`, [old.threadId]));
  await svc.applyRetention();
  await assert.rejects(svc.snapshot(s, old.threadId), (e: { code: string }) => e.code === 'not_found');
  assert.equal((await svc.snapshot(s, fresh.threadId)).threadId, fresh.threadId);
});

test('retention and history deletion remove workflows and their checkpoints', async () => {
  const { s } = await demoUser(svc);
  const w = await startBlock(s);
  await svc.memory.remember(s.userId, 'I prefer blocking over pausing', false);
  const out = await svc.deleteHistory(s);
  assert.ok(out.deletedWorkflows >= 1);
  await assert.rejects(svc.snapshot(s, w.threadId), (e: { code: string }) => e.code === 'not_found');
  await svc.updateSettings(s, { memoryOptOut: true });
  await assert.rejects(svc.memory.remember(s.userId, 'x', true), /switched off/);
  await svc.updateSettings(s, { agentEnabled: false });
  const off = await startBlock(s);
  assert.equal(off.status, 'denied');
  assert.match(off.explanation!, /switched off/);
});
