import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { approval, aliasIdOf, demoUser, makeService, senderId } from './helpers.js';
import type { AgentService } from '../src/service.js';
import type { MockProvider } from '../src/providers/mock.js';

let svc: AgentService, mock: MockProvider;
before(async () => { ({ svc, provider: mock } = await makeService()); });
after(async () => { await svc.close(); });

const blockBrightline = async (s: Parameters<AgentService['start']>[0], user: string) =>
  svc.start(s, { text: 'Stop promo@brightline-ads.com from emailing my Nova Market alias' });

test('primary use case: approve → execute → verify → receipt → audit', async () => {
  const { s, user } = await demoUser(svc);
  const w = await blockBrightline(s, user);
  assert.equal(w.status, 'awaiting_approval');
  assert.equal(w.mode, 'simulation');
  assert.deepEqual(w.path, ['parse_intent', 'authorize', 'resolve_target', 'retrieve_context', 'propose_actions', 'evaluate_policy']);
  const a = approval(w);
  assert.equal(a.type, 'approval');
  assert.equal(a.risk, 'medium');
  assert.equal(w.selectedAction!.action, 'block_sender', 'least disruptive action is selected');
  assert.ok(w.candidateActions.some((c) => c.action === 'pause_alias'), 'the broader option is shown but not selected');
  assert.equal(mock.writes().length, 0, 'nothing written before approval');

  const done = await svc.decide(s, w.threadId, { approvalId: a.approvalId, actionHash: a.actionHash, decision: 'approve' });
  assert.equal(done.status, 'verified');
  assert.deepEqual(done.path.slice(-4), ['request_approval', 'revalidate_execute', 'verify_outcome', 'finalize']);
  assert.equal(done.verification!.status, 'verified');
  assert.equal(mock.writes().length, 1);
  const r = done.receipts[0];
  assert.equal(r.status, 'verified');
  assert.match(r.commitment!, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(r.sanitized_input), /calm\.fox\.7k2/, 'receipt holds the masked alias only');
  const audit = await svc.audit(s);
  assert.equal(audit.anchored, false, 'local commitments are never reported as on-chain');
  assert.ok(audit.events.every((e) => e.intact));
  const hist = await svc.history(s);
  assert.equal(hist[0].undo, 'unblock_sender');
});

test('decline: nothing is executed and the decline is recorded', async () => {
  const { s, user } = await demoUser(svc);
  const before = mock.writes().length;
  const w = await blockBrightline(s, user);
  const a = approval(w);
  const done = await svc.decide(s, w.threadId, { approvalId: a.approvalId, actionHash: a.actionHash, decision: 'decline' });
  assert.equal(done.status, 'declined');
  assert.ok(done.path.includes('record_decline'));
  assert.equal(mock.writes().length, before);
});

test('undo creates a new, separately approved inverse workflow', async () => {
  const { s, user } = await demoUser(svc);
  const w = await blockBrightline(s, user);
  const a = approval(w);
  await svc.decide(s, w.threadId, { approvalId: a.approvalId, actionHash: a.actionHash, decision: 'approve' });
  const receipt = (await svc.history(s))[0];
  const undo = await svc.undo(s, receipt.id);
  assert.equal(undo.status, 'awaiting_approval');
  assert.equal(undo.selectedAction!.action, 'unblock_sender');
  const ua = approval(undo);
  const fin = await svc.decide(s, undo.threadId, { approvalId: ua.approvalId, actionHash: ua.actionHash, decision: 'approve' });
  assert.equal(fin.status, 'verified');
  const sid = await senderId(svc, s, 'promo@brightline-ads.com');
  assert.equal((await svc.listAliases(s)).flatMap((x) => x.senders).find((x) => x.id === sid)!.blocked, false);
});

test('ambiguous target pauses for a choice, then resumes at resolve_target', async () => {
  const { s } = await demoUser(svc);
  const w = await svc.start(s, { text: 'Stop this third party from emailing me' });
  assert.equal(w.status, 'needs_target');
  const it = w.interrupt as { type: string; candidates: { aliasId: string; senderId: string; label: string }[] };
  assert.equal(it.type, 'select_target');
  assert.ok(it.candidates.length >= 3);
  assert.ok(it.candidates.some((c) => /payment processor/.test(c.label)), 'legitimate third parties are labelled');
  const pick = it.candidates.find((c) => c.label.includes('brightline'))!;
  const next = await svc.selectTarget(s, w.threadId, { aliasId: pick.aliasId, senderId: pick.senderId });
  assert.equal(next.status, 'awaiting_approval');
  assert.deepEqual(next.path.slice(2, 5), ['resolve_target', 'select_target', 'resolve_target']);
});

test('sender already blocked: no approval is requested and nothing is written', async () => {
  const { s, user } = await demoUser(svc);
  mock.aliases.get(`${user}-101`)!.contacts.find((c) => c.address === 'promo@brightline-ads.com')!.blocked = true;
  const before = mock.writes().length;
  const w = await svc.start(s, { intent: 'block_sender', aliasId: aliasIdOf(user, 'nova'), senderId: await senderId(svc, s, 'promo@brightline-ads.com') });
  assert.equal(w.status, 'completed');
  assert.ok(w.path.includes('already_done'));
  assert.equal(mock.writes().length, before);
});

test('legitimate third party: high risk, warning shown, never auto-approved', async () => {
  const { s, user } = await demoUser(svc);
  await svc.addPolicy(s, { kind: 'auto_approve', action: 'block_sender', aliasId: aliasIdOf(user, 'nova'), senderDomain: 'stripe.com', days: 7 });
  const w = await svc.start(s, { text: 'Block receipts@stripe.com on my Nova Market alias' });
  assert.equal(w.status, 'awaiting_approval', 'high risk ignores auto-approval');
  assert.equal(approval(w).risk, 'high');
  assert.match(approval(w).warnings.join(' '), /payment processor/);
});

test('never blocks the original service; suggests pausing instead', async () => {
  const { s, user } = await demoUser(svc);
  const w = await svc.start(s, { intent: 'block_sender', aliasId: aliasIdOf(user, 'nova'), senderId: await senderId(svc, s, 'orders@mail.novamarket.com') });
  assert.equal(w.status, 'denied');
  assert.equal(w.policy!.alternative, 'pause_alias');
  assert.ok(w.policy!.rules.some((r) => r.id === 'P6-not-original-service' && !r.passed));
});

test('standing policy: narrow auto-approval runs without an interrupt; "always ask" wins', async () => {
  const { s, user } = await demoUser(svc);
  const aliasId = aliasIdOf(user, 'forum');
  await svc.addPolicy(s, { kind: 'auto_approve', action: 'block_sender', aliasId, senderDomain: 'datavista-leads.com', days: 7 });
  const w = await svc.start(s, { text: 'Block deals@datavista-leads.com on my Chess Forum alias' });
  assert.equal(w.status, 'verified');
  assert.ok(!w.path.includes('request_approval'));
  assert.ok(w.policy!.autoApprovedBy);

  const { s: s2, user: u2 } = await demoUser(svc);
  await svc.addPolicy(s2, { kind: 'auto_approve', action: 'block_sender', aliasId: aliasIdOf(u2, 'forum'), senderDomain: 'datavista-leads.com', days: 7 });
  await svc.addPolicy(s2, { kind: 'always_require_approval', action: 'block_sender' });
  assert.equal((await svc.start(s2, { text: 'Block deals@datavista-leads.com on my Chess Forum alias' })).status, 'awaiting_approval');
  await assert.rejects(svc.addPolicy(s2, { kind: 'auto_approve', action: 'pause_alias', aliasId: aliasIdOf(u2, 'forum'), days: 7 }), /pre-approved|name one alias/);
});

test('unsubscribe without verified headers is unsupported and offers blocking instead', async () => {
  const { s } = await demoUser(svc);
  const w = await svc.start(s, { text: 'Unsubscribe me from the company sending spam to my Chess Forum alias' });
  assert.equal(w.status, 'unsupported');
  assert.ok(w.path.includes('explain_limitation'));
  assert.match(w.explanation!, /DKIM/);
  assert.match(w.explanation!, /block/i);
  assert.ok(w.candidateActions.some((c) => c.action === 'block_sender'));
});

test('read-only agents return findings and never propose writes', async () => {
  const { s } = await demoUser(svc);
  for (const [text, kind] of [['Show me accounts that may need password rotation', 'review_accounts'], ['Help me clean up old accounts and unused aliases', 'cleanup_dormant'],
    ['Summarize what NEARAuth has done to protect my privacy this month', 'summarize_history']] as const) {
    const w = await svc.start(s, { text });
    assert.equal(w.status, 'completed', text);
    assert.equal((w.findings as { kind: string }).kind, kind);
    assert.ok(w.path.includes('return_findings'));
    assert.ok(!w.path.includes('propose_actions'));
  }
  const inv = await svc.start(s, { text: 'Investigate which companies may have received my Chess Forum alias' });
  assert.equal(inv.status, 'completed');
  const rot = await svc.start(s, { text: 'Show me accounts that may need password rotation' });
  assert.match(rot.explanation!, /cannot change passwords/);
});

test('pause and resume an alias, verified against the provider', async () => {
  const { s, user } = await demoUser(svc);
  const w = await svc.start(s, { text: 'Pause the alias for Trailhead' });
  const a = approval(w);
  assert.match(a.warnings.join(' '), /stops all mail/);
  const done = await svc.decide(s, w.threadId, { approvalId: a.approvalId, actionHash: a.actionHash, decision: 'approve' });
  assert.equal(done.status, 'verified');
  assert.equal(mock.aliases.get(`${user}-102`)!.enabled, false);
  const r = await svc.start(s, { text: 'Resume my Trailhead alias' });
  const ra = approval(r);
  assert.equal((await svc.decide(s, r.threadId, { approvalId: ra.approvalId, actionHash: ra.actionHash, decision: 'approve' })).status, 'verified');
  assert.equal(mock.aliases.get(`${user}-102`)!.enabled, true);
});

test('unknown requests explain what is supported', async () => {
  const { s } = await demoUser(svc);
  const w = await svc.start(s, { text: 'what is the weather tomorrow' });
  assert.equal(w.status, 'unsupported');
  assert.deepEqual(w.path, ['parse_intent', 'explain_limitation', 'finalize']);
});
