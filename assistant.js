/* NEARAuth Privacy Assistant — dashboard client for the agent service (agent/).
 * Talks to the agent over HTTPS/HTTP with a bearer session token kept in sessionStorage (cleared when the tab closes).
 * Everything rendered from the agent is escaped; sender names and other provider data are untrusted text. */
(function () {
  'use strict';
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var store = {
    get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
  };
  var S = { url: store.get('nearauth_agent_url') || 'http://127.0.0.1:8787', token: store.get('nearauth_agent_token'), health: null, graph: null, tab: 'assistant',
    workflow: null, approvals: [], history: [], policies: [], memory: [], settings: null, aliases: [], busy: false, error: null, animate: 0 };

  var SUGGESTIONS = [
    'Stop this third party from emailing me',
    'Block this third-party sender, but keep the original service working',
    'Unsubscribe me from the company sending spam to my Chess Forum alias',
    'Investigate which companies may have received my Chess Forum alias',
    'Show me accounts that may need password rotation',
    'Pause the alias for Trailhead',
    'Help me clean up old accounts and unused aliases',
    'Summarize what NEARAuth has done to protect my privacy this month',
  ];
  var STATUS = {
    planned: ['gray', 'planned'], awaiting_approval: ['amber', 'awaiting approval'], running: ['blue', 'running'], requested: ['blue', 'requested'],
    verified: ['green', 'verified'], failed: ['red', 'failed'], unsupported: ['gray', 'unsupported'], denied: ['red', 'denied'], declined: ['gray', 'declined'],
    expired: ['gray', 'expired'], completed: ['green', 'completed'], needs_target: ['amber', 'needs your choice'], cancelled: ['gray', 'cancelled'],
    already_done: ['green', 'already done'],
  };
  var chip = function (st) { var m = STATUS[st] || ['gray', st]; return '<span class="chip ' + m[0] + ' as-chip">' + esc(m[1]) + '</span>'; };

  /* ------------------------------------------------------------------ API */
  function api(method, path, body) {
    var headers = { Accept: 'application/json' };
    if (S.token) headers.Authorization = 'Bearer ' + S.token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(S.url.replace(/\/+$/, '') + path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit', referrerPolicy: 'no-referrer' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.message || ('HTTP ' + r.status)); e.code = j.error; e.status = r.status; throw e; } return j; }); });
  }
  function run(fn) {
    S.busy = true; S.error = null; draw();
    return Promise.resolve().then(fn).catch(function (e) {
      S.error = e.message || String(e);
      if (e.status === 401 && e.code === 'unauthenticated') { S.token = null; store.set('nearauth_agent_token', null); }
    }).then(function () { S.busy = false; draw(); });
  }

  function connect() {
    var url = document.getElementById('as-url').value.trim(), token = document.getElementById('as-token').value.trim();
    if (!/^https?:\/\//.test(url)) { S.error = 'Agent URL must start with http:// or https://'; return draw(); }
    S.url = url; S.token = token || null;
    store.set('nearauth_agent_url', url); store.set('nearauth_agent_token', S.token);
    return run(loadAll);
  }
  function disconnect() {
    var t = S.token;
    S.token = null; store.set('nearauth_agent_token', null); S.workflow = null; draw();
    if (t) fetch(S.url + '/v1/session/revoke', { method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: '{}' }).catch(function () {});
  }
  function loadAll() {
    return api('GET', '/v1/health').then(function (h) { S.health = h; return api('GET', '/v1/graph'); }).then(function (g) {
      S.graph = g;
      if (!S.token) return;
      return Promise.all([api('GET', '/v1/approvals'), api('GET', '/v1/history'), api('GET', '/v1/policies'), api('GET', '/v1/memory'), api('GET', '/v1/settings'), api('GET', '/v1/aliases')])
        .then(function (r) { S.approvals = r[0]; S.history = r[1]; S.policies = r[2]; S.memory = r[3]; S.settings = r[4]; S.aliases = r[5]; });
    });
  }
  function refreshSide() {
    return Promise.all([api('GET', '/v1/approvals'), api('GET', '/v1/history')]).then(function (r) { S.approvals = r[0]; S.history = r[1]; }).catch(function () {});
  }
  function showWorkflow(w) { S.workflow = w; S.animate = Date.now(); S.tab = 'assistant'; return refreshSide(); }

  function ask(text) {
    text = (text || document.getElementById('as-input').value || '').trim();
    if (!text) return;
    return run(function () { return api('POST', '/v1/workflows', { text: text }).then(showWorkflow); });
  }
  function decide(decision) {
    var w = S.workflow, it = w && w.interrupt;
    if (!it || it.type !== 'approval') return;
    return run(function () { return api('POST', '/v1/workflows/' + w.threadId + '/decision', { approvalId: it.approvalId, actionHash: it.actionHash, decision: decision }).then(showWorkflow); });
  }
  function pick(i) {
    var w = S.workflow, c = w.interrupt.candidates[i];
    var body = { aliasId: c.aliasId }; if (c.senderId) body.senderId = c.senderId;
    return run(function () { return api('POST', '/v1/workflows/' + w.threadId + '/target', body).then(showWorkflow); });
  }
  function openWorkflow(id) { return run(function () { return api('GET', '/v1/workflows/' + id).then(showWorkflow); }); }
  function cancelWorkflow() { var w = S.workflow; return run(function () { return api('POST', '/v1/workflows/' + w.threadId + '/cancel', {}).then(showWorkflow); }); }
  function undo(id) { return run(function () { return api('POST', '/v1/receipts/' + id + '/undo', {}).then(showWorkflow); }); }
  function addPolicy() {
    var v = function (id) { return document.getElementById(id).value; };
    var body = { kind: v('as-pkind'), action: v('as-paction') };
    if (v('as-palias')) body.aliasId = v('as-palias');
    if (v('as-pdomain').trim()) body.senderDomain = v('as-pdomain').trim();
    if (body.kind === 'auto_approve') body.days = Number(v('as-pdays') || 7);
    return run(function () { return api('POST', '/v1/policies', body).then(function () { return api('GET', '/v1/policies'); }).then(function (p) { S.policies = p; }); });
  }
  function removePolicy(id) { return run(function () { return api('DELETE', '/v1/policies/' + id).then(function () { return api('GET', '/v1/policies'); }).then(function (p) { S.policies = p; }); }); }
  function saveSetting(k, val) {
    var body = {}; body[k] = val;
    return run(function () { return api('PATCH', '/v1/settings', body).then(function (s) { S.settings = s; return api('GET', '/v1/memory'); }).then(function (m) { S.memory = m; }); });
  }
  function deleteHistory() {
    if (!window.confirm('Delete all agent workflows, receipts, audit events and learned memory? Aliases and policies are kept. This cannot be undone.')) return;
    return run(function () { return api('DELETE', '/v1/history').then(function () { S.workflow = null; return loadAll(); }); });
  }
  function remember() {
    var t = document.getElementById('as-mem').value.trim(); if (!t) return;
    return run(function () { return api('POST', '/v1/memory', { text: t }).then(function () { return api('GET', '/v1/memory'); }).then(function (m) { S.memory = m; }); });
  }
  function forget(id) { return run(function () { return api('DELETE', '/v1/memory/' + id).then(function () { return api('GET', '/v1/memory'); }).then(function (m) { S.memory = m; }); }); }

  /* Sends alias and sender REFERENCES from this browser's extension data (no passwords, no keys). */
  function syncFromBrowser() {
    var accounts = [], inbound = [];
    try { accounts = JSON.parse(localStorage.getItem('nearauth_ext_accounts_v1')) || []; inbound = JSON.parse(localStorage.getItem('nearauth_ext_inbound_v1')) || []; } catch (e) { /* none */ }
    var aliases = accounts.filter(function (a) { return a && a.alias && a.domain && /\./.test(a.domain); }).map(function (a) {
      return { alias: a.alias, service: String(a.name || a.domain).slice(0, 80), domain: a.domain, provider: a.providerId === 'simplelogin' ? 'simplelogin' : a.providerId === 'addy' ? 'addy' : 'demo',
        remoteId: a.remoteId != null ? String(a.remoteId) : null, credentialStatus: ['none', 'generated-not-stored', 'vault-encrypted'].indexOf(a.credentials) >= 0 ? a.credentials : 'unknown',
        createdAt: a.createdAt || null };
    });
    var observations = inbound.filter(function (e) { return e && e.alias && e.sender && /@/.test(e.sender); }).map(function (e) {
      return { alias: e.alias, sender: e.sender, blocked: e.action === 'blocked' || e.action === 'already-blocked', remoteContactId: e.senderId != null ? String(e.senderId) : null };
    });
    if (!aliases.length) { S.error = 'No extension aliases in this browser to sync. In simulation mode the demo data is already loaded.'; return draw(); }
    return run(function () { return api('POST', '/v1/sync', { aliases: aliases, observations: observations }).then(function (r) { toastMsg('Synced ' + r.accepted + ' alias(es), ' + r.observations + ' sender(s); ' + r.rejected + ' rejected'); return loadAll(); }); });
  }
  function toastMsg(t) { if (typeof window.toast === 'function') window.toast(t); }

  /* ------------------------------------------------------------------ graph picture */
  var POS = {
    parse_intent: [170, 30], authorize: [170, 95], resolve_target: [170, 160], retrieve_context: [170, 225], propose_actions: [170, 290], evaluate_policy: [170, 355],
    request_approval: [170, 420], revalidate_execute: [170, 485], verify_outcome: [170, 550], finalize: [170, 625],
    select_target: [420, 160], explain_limitation: [420, 60], deny: [420, 300], return_findings: [420, 225], already_done: [420, 420], record_decline: [420, 495],
  };
  function graphSvg(w) {
    if (!S.graph) return '';
    var path = (w && w.path) || [];
    var done = {}; path.forEach(function (n) { done[n] = true; });
    var walked = {}; for (var i = 0; i + 1 < path.length; i++) walked[path[i] + '>' + path[i + 1]] = true;
    if (path.length) walked['__start__>' + path[0]] = true;
    var waiting = w && w.interrupt ? (w.interrupt.type === 'approval' ? 'request_approval' : 'select_target') : null;
    var W = 160, H = 34;
    var edges = S.graph.edges.filter(function (e) { return POS[e.from] && POS[e.to]; }).map(function (e) {
      var a = POS[e.from], b = POS[e.to], hot = walked[e.from + '>' + e.to] || (waiting === e.to && e.from === path[path.length - 1]);
      var x1 = a[0] + (b[0] > a[0] ? W / 2 : b[0] < a[0] ? -W / 2 : 0), y1 = a[1] + (b[0] === a[0] ? (b[1] > a[1] ? H / 2 : -H / 2) : 0);
      var x2 = b[0] + (b[0] > a[0] ? -W / 2 : b[0] < a[0] ? W / 2 : 0), y2 = b[1] + (b[0] === a[0] ? (b[1] > a[1] ? -H / 2 : H / 2) : 0);
      var curve = e.from === 'select_target' && e.to === 'resolve_target' ? ' Q 330 ' + (a[1] - 40) + ' ' : ' L ';
      var d = 'M ' + x1 + ' ' + y1 + curve + x2 + ' ' + y2;
      if (e.from === 'select_target' && e.to === 'resolve_target') d = 'M ' + (a[0] - W / 2) + ' ' + (a[1] - 8) + ' Q 295 ' + (a[1] - 38) + ' ' + (b[0] + W / 2) + ' ' + (b[1] - 8);
      if (e.from === 'resolve_target' && e.to === 'select_target') d = 'M ' + (a[0] + W / 2) + ' ' + (a[1] + 8) + ' L ' + (b[0] - W / 2) + ' ' + (b[1] + 8);
      if (e.to === 'finalize' && a[0] !== b[0]) d = 'M ' + (a[0] + W / 2) + ' ' + a[1] + ' L 525 ' + a[1] + ' L 525 ' + b[1] + ' L ' + (b[0] + W / 2) + ' ' + b[1];
      return '<path d="' + d + '" class="as-edge' + (hot ? ' hot' : '') + '" marker-end="url(#as-arrow' + (hot ? '-hot' : '') + ')"><title>' + esc(e.from + ' → ' + e.to + (e.when ? ' · ' + e.when : '')) + '</title></path>';
    }).join('');
    var nodes = S.graph.nodes.filter(function (n) { return POS[n.id]; }).map(function (n) {
      var p = POS[n.id], cls = 'as-node ' + n.kind + (done[n.id] ? ' done' : '') + (waiting === n.id ? ' waiting' : '');
      var order = path.indexOf(n.id), delay = order >= 0 ? (order * 0.12).toFixed(2) + 's' : '0s';
      return '<g class="' + cls + '" style="animation-delay:' + delay + '" tabindex="0" role="img" aria-label="' + esc((n.n ? n.n + '. ' : '') + n.label + (done[n.id] ? ', executed' : '') + (waiting === n.id ? ', waiting for you' : '')) + '">'
        + '<rect x="' + (p[0] - W / 2) + '" y="' + (p[1] - H / 2) + '" width="' + W + '" height="' + H + '" rx="' + (n.kind === 'terminal' ? 17 : 8) + '"/>'
        + '<text x="' + p[0] + '" y="' + (p[1] + 4) + '">' + esc((n.n ? n.n + '. ' : '') + n.label) + '</text><title>' + esc(n.does) + '</title></g>';
    }).join('');
    return '<svg class="as-graph" viewBox="60 0 480 650" role="group" aria-label="LangGraph workflow: executed nodes are highlighted">'
      + '<defs><marker id="as-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10z" fill="#3a4b66"/></marker>'
      + '<marker id="as-arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10z" fill="#70e5c2"/></marker></defs>'
      + edges + nodes + '</svg>';
  }

  /* ------------------------------------------------------------------ views */
  function modeBanner() {
    var h = S.health;
    if (!h) return '<span class="chip gray">agent not connected</span>';
    return h.provider.mode === 'simulation'
      ? '<span class="chip amber" title="' + esc(h.provider.label) + '">SIMULATION · mock provider</span>'
      : '<span class="chip red" title="' + esc(h.provider.label) + '">REAL PROVIDER · ' + esc(h.provider.id) + '</span>';
  }
  function connectPanel() {
    return '<div class="panel as-connect"><h3>Connect to your NEARAuth agent</h3><p class="panel-sub">The assistant runs in a separate local service (GitHub Pages cannot run it). No paid AI or accounts needed:</p>'
      + '<pre class="as-pre">cd agent &amp;&amp; npm install &amp;&amp; npm run demo</pre><p class="panel-sub">It prints a session token. Paste it below. The token stays in this tab only.</p>'
      + '<div class="as-form"><label>Agent URL<input id="as-url" value="' + esc(S.url) + '" spellcheck="false"></label><label>Session token<input id="as-token" type="password" autocomplete="off" spellcheck="false" placeholder="paste token"></label>'
      + '<button class="btn primary" data-act="connect">Connect</button></div></div>';
  }
  function tabs() {
    var t = [['assistant', 'Assistant'], ['approvals', 'Approval Center' + (S.approvals.filter(function (a) { return !a.expired; }).length ? ' (' + S.approvals.filter(function (a) { return !a.expired; }).length + ')' : '')],
      ['history', 'Action History'], ['policies', 'Policy & Permissions'], ['memory', 'Privacy Memory'], ['explain', 'How it works']];
    return '<div class="as-tabs" role="tablist">' + t.map(function (x) { return '<button role="tab" aria-selected="' + (S.tab === x[0]) + '" class="' + (S.tab === x[0] ? 'active' : '') + '" data-tab="' + x[0] + '">' + esc(x[1]) + '</button>'; }).join('') + '</div>';
  }
  function approvalCard(w) {
    var it = w.interrupt, mins = Math.max(0, Math.round((new Date(it.expiresAt) - Date.now()) / 60000));
    return '<div class="as-approval ' + esc(it.risk) + '"><div class="inline-row"><div><div class="eyebrow">APPROVAL NEEDED · ' + esc(it.provider.mode === 'simulation' ? 'SIMULATION' : 'REAL PROVIDER') + '</div><h3>' + esc(it.title) + '</h3></div>'
      + '<span class="chip ' + (it.risk === 'high' ? 'red' : it.risk === 'medium' ? 'amber' : 'green') + '">' + esc(it.risk) + ' risk</span></div>'
      + '<p>' + esc(it.effect) + '</p><dl class="as-dl">'
      + '<dt>Alias</dt><dd>' + esc(it.target.service) + ' · ' + esc(it.target.alias) + '</dd>' + (it.target.sender ? '<dt>Sender</dt><dd>' + esc(it.target.sender) + '</dd>' : '')
      + '<dt>Provider</dt><dd>' + esc(it.provider.label) + '</dd><dt>Reversible</dt><dd>' + (it.reversible ? 'Yes — undo: ' + esc(it.undo) : 'No') + '</dd>'
      + '<dt>Expires</dt><dd>in ' + mins + ' min · single use</dd><dt>Action hash</dt><dd class="hash">' + esc(it.actionHash.slice(0, 24)) + '…</dd></dl>'
      + (it.warnings.length ? '<div class="notice">' + it.warnings.map(esc).join('<br>') + '</div>' : '')
      + (it.alternatives.length ? '<p class="panel-sub">Other options considered: ' + it.alternatives.map(function (a) { return esc(a.title) + ' (' + esc(a.effect) + ')'; }).join('; ') + '</p>' : '')
      + '<div class="as-actions"><button class="btn primary" data-act="approve">Approve this exact action</button><button class="btn secondary" data-act="decline">Decline</button><button class="btn secondary" data-act="cancel">Cancel workflow</button></div></div>';
  }
  function targetCard(w) {
    return '<div class="as-approval"><div class="eyebrow">WHICH ONE?</div><h3>' + esc(w.interrupt.question) + '</h3><p class="panel-sub">The graph is paused at “Ask which one”. NEARAuth never guesses which alias you meant.</p>'
      + '<div class="as-cands">' + w.interrupt.candidates.map(function (c, i) { return '<button class="btn secondary" data-pick="' + i + '">' + esc(c.label) + '</button>'; }).join('') + '</div></div>';
  }
  function policyTable(p) {
    if (!p) return '';
    return '<details class="as-details"' + (p.outcome !== 'allow' ? ' open' : '') + '><summary>Policy checks — ' + esc(p.outcome) + (p.autoApprovedBy ? ' (standing policy)' : '') + '</summary><table class="as-table"><tbody>'
      + p.rules.map(function (r) { return '<tr><td>' + (r.passed ? '✓' : '✗') + '</td><td><b>' + esc(r.id) + '</b><br><span class="muted">' + esc(r.title) + '</span></td><td>' + esc(r.detail) + '</td></tr>'; }).join('') + '</tbody></table></details>';
  }
  function findingsView(f) {
    if (!f) return '';
    var rows = '';
    if (f.kind === 'review_accounts') rows = f.accounts.map(function (a) { return '<li><b>' + esc(a.service) + '</b> (' + esc(a.alias) + ') — ' + esc(a.reason) + '</li>'; }).join('') + '</ul><p class="panel-sub">Checklist:</p><ol>' + f.checklist.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ol><ul>';
    else if (f.kind === 'cleanup_dormant') rows = f.dormant.map(function (a) { return '<li><b>' + esc(a.service) + '</b> — idle ' + esc(a.idleDays) + ' days</li>'; }).join('');
    else if (f.kind === 'summarize_history') rows = Object.keys(f.byStatus).map(function (k) { return '<li>' + esc(k) + ': ' + esc(f.byStatus[k]) + '</li>'; }).join('');
    else if (f.kind === 'explain_audit') rows = f.events.map(function (e) { return '<li>' + esc(new Date(e.created_at).toLocaleString()) + ' — ' + esc(e.label) + '</li>'; }).join('');
    else if (f.evidence) rows = f.evidence.map(function (e) { return '<li>' + esc(e.detail) + '</li>'; }).join('') + '</ul><p class="panel-sub">Possible explanations:</p><ul>' + f.possibleExplanations.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('');
    else if (f.senders) rows = f.senders.map(function (s) { return '<li>' + esc(s.address) + ' — ' + esc(s.classification) + (s.blocked ? ' (blocked)' : '') + '</li>'; }).join('');
    return rows ? '<div class="as-findings"><ul>' + rows + '</ul></div>' : '';
  }
  function timeline(w) {
    if (!w.toolCalls.length) return '';
    return '<div class="panel as-panel"><div class="panel-heading"><div><h3>Tool timeline</h3><div class="panel-sub">Every tool call the graph made, with sanitized inputs and outcomes. Privileged tools only run with an approval grant.</div></div></div><div class="as-scroll"><table class="as-table"><thead><tr><th>Time</th><th>Tool</th><th>Kind</th><th>Caller</th><th>Input</th><th>Outcome</th></tr></thead><tbody>'
      + w.toolCalls.map(function (t) { return '<tr><td>' + esc(new Date(t.at).toLocaleTimeString()) + '</td><td><b>' + esc(t.tool) + '</b></td><td><span class="chip ' + (t.kind === 'privileged' ? 'red' : t.kind === 'propose' ? 'amber' : 'gray') + '">' + esc(t.kind) + '</span></td><td>' + esc(t.caller)
        + '</td><td class="hash">' + esc(JSON.stringify(t.input)) + '</td><td>' + (t.status === 'ok' ? '<span class="hash">' + esc(JSON.stringify(t.output)).slice(0, 220) + '</span>' : '<span class="chip red">' + esc(t.error) + '</span>') + '</td></tr>'; }).join('')
      + '</tbody></table></div></div>';
  }
  function workflowView() {
    var w = S.workflow;
    if (!w) return '<div class="empty">Ask for something above, or pick a suggestion. The graph will light up node by node.</div>';
    var interrupt = w.interrupt ? (w.interrupt.type === 'approval' ? approvalCard(w) : targetCard(w)) : '';
    return '<div class="as-grid"><div class="panel as-panel"><div class="panel-heading"><div><h3>Workflow graph</h3><div class="panel-sub">Executed nodes in green; the amber node is waiting for you. Hover a node for what it does.</div></div></div>' + graphSvg(w) + '</div>'
      + '<div class="panel as-panel"><div class="inline-row"><div><div class="eyebrow">' + esc(w.intentLabel || 'Request') + (w.intentSource ? ' · via ' + esc(w.intentSource) : '') + '</div><h3>“' + esc(w.request) + '”</h3></div>' + chip(w.status) + '</div>'
      + '<p>' + esc(w.explanation || '') + '</p>'
      + (w.resolution ? '<p class="panel-sub">Target: ' + esc(w.resolution.detail) + ' <span class="muted">(' + esc(w.resolution.method) + ')</span></p>' : '')
      + interrupt + findingsView(w.findings) + policyTable(w.policy)
      + (w.receipts.length ? '<p class="panel-sub">Receipt ' + esc(w.receipts[0].id) + ' · ' + esc(w.receipts[0].status) + ' · ' + esc(w.receipts[0].mode) + ' · attempts ' + esc(w.receipts[0].attempts) + (w.receipts[0].commitment ? '<br>Local audit commitment <span class="hash">' + esc(w.receipts[0].commitment) + '</span> (not on-chain)' : '') + '</p>' : '')
      + '<p class="panel-sub">Executed path: ' + esc(w.path.join(' → ') || '—') + '</p></div></div>' + timeline(w);
  }
  function assistantTab() {
    return '<div class="panel as-panel"><label class="as-label" for="as-input">What should NEARAuth do?</label><div class="as-ask"><textarea id="as-input" rows="2" maxlength="1000" placeholder="e.g. Stop this third party from emailing me"></textarea><button class="btn primary" data-act="ask">Ask</button></div>'
      + '<div class="as-sugs">' + SUGGESTIONS.map(function (s, i) { return '<button class="as-sug" data-sug="' + i + '">' + esc(s) + '</button>'; }).join('') + '</div>'
      + '<div class="inline-row as-meta"><span class="panel-sub">Model: ' + esc(S.health && S.health.model) + ' · Embeddings: ' + esc(S.health && S.health.embedder) + ' · Database: ' + esc(S.health && S.health.database) + '</span>'
      + '<button class="btn secondary as-small" data-act="sync">Sync aliases from this browser</button></div></div>' + workflowView();
  }
  function approvalsTab() {
    if (!S.approvals.length) return '<div class="empty">No approvals waiting.</div>';
    return '<div class="panel as-panel"><table class="as-table"><thead><tr><th>Action</th><th>Target</th><th>Expires</th><th></th></tr></thead><tbody>' + S.approvals.map(function (a) {
      return '<tr><td><b>' + esc(a.title) + '</b><br><span class="muted">' + esc(a.effect) + '</span></td><td>' + esc(a.target.service) + ' · ' + esc(a.target.alias) + (a.target.sender ? '<br>' + esc(a.target.sender) : '') + '</td><td>' + (a.expired ? '<span class="chip gray">expired</span>' : esc(new Date(a.expiresAt).toLocaleTimeString())) + '</td><td><button class="btn secondary as-small" data-open="' + esc(a.threadId) + '">Review</button></td></tr>';
    }).join('') + '</tbody></table></div>';
  }
  function historyTab() {
    if (!S.history.length) return '<div class="empty">No actions yet.</div>';
    return '<div class="panel as-panel"><div class="as-scroll"><table class="as-table"><thead><tr><th>When</th><th>Action</th><th>Target</th><th>Status</th><th>Mode</th><th>Receipt</th><th></th></tr></thead><tbody>' + S.history.map(function (r) {
      return '<tr><td>' + esc(new Date(r.createdAt).toLocaleString()) + '</td><td><b>' + esc(r.title || r.action) + '</b><br><span class="muted">' + esc(r.request) + '</span></td><td>' + esc(r.input.alias) + (r.input.sender ? '<br>' + esc(r.input.sender) : '') + '</td><td>' + chip(r.status) + '</td><td>' + esc(r.mode)
        + '</td><td class="hash">' + esc(r.id) + '<br>attempts ' + esc(r.attempts) + (r.commitment ? '<br>' + esc(r.commitment.slice(0, 20)) + '…' : '') + (r.errorCode ? '<br><span class="chip red">' + esc(r.errorCode) + '</span>' : '') + '</td><td>'
        + (r.undo ? '<button class="btn secondary as-small" data-undo="' + esc(r.id) + '">Undo</button> ' : '') + '<button class="btn secondary as-small" data-open="' + esc(r.threadId) + '">Open</button></td></tr>';
    }).join('') + '</tbody></table></div></div>';
  }
  function policiesTab() {
    var st = S.settings || {};
    var opts = S.aliases.map(function (a) { return '<option value="' + esc(a.id) + '">' + esc(a.service) + ' · ' + esc(a.alias) + '</option>'; }).join('');
    return '<div class="as-grid"><div class="panel as-panel"><h3>Permissions</h3><p class="panel-sub">The default is read-only and approval-driven. Nothing changes at a provider without an approval or a narrow standing policy.</p>'
      + '<label class="as-check"><input type="checkbox" data-set="agentEnabled"' + (st.agentEnabled ? ' checked' : '') + '> Agentic features on (off = every workflow is denied)</label>'
      + '<label class="as-check"><input type="checkbox" data-set="memoryOptOut"' + (st.memoryOptOut ? ' checked' : '') + '> Opt out of learned memory (deletes stored incident summaries and notes)</label>'
      + '<label class="as-inline">Keep history for <input type="number" min="1" max="3650" id="as-ret" value="' + esc(st.retentionDays || 90) + '"> days <button class="btn secondary as-small" data-act="retention">Save</button></label>'
      + '<button class="btn secondary" data-act="delete-history">Delete agent history now</button></div>'
      + '<div class="panel as-panel"><h3>Standing policies</h3><p class="panel-sub">“Always ask” beats everything. Auto-approval must name one alias, one sender domain and an expiry, and is never used for high-risk senders.</p>'
      + (S.policies.length ? '<table class="as-table"><tbody>' + S.policies.map(function (p) { return '<tr><td><b>' + esc(p.kind.replace(/_/g, ' ')) + '</b> · ' + esc(p.action) + '</td><td>' + esc(p.alias_id || 'any alias') + (p.sender_domain ? ' · ' + esc(p.sender_domain) : '') + (p.expires_at ? '<br><span class="muted">until ' + esc(new Date(p.expires_at).toLocaleDateString()) + '</span>' : '') + '</td><td><button class="btn secondary as-small" data-rmpol="' + esc(p.id) + '">Remove</button></td></tr>'; }).join('') + '</tbody></table>' : '<div class="empty">No standing policies.</div>')
      + '<div class="as-form"><label>Kind<select id="as-pkind"><option value="always_require_approval">Always ask</option><option value="auto_approve">Auto-approve (narrow)</option></select></label>'
      + '<label>Action<select id="as-paction"><option>block_sender</option><option>unblock_sender</option><option>pause_alias</option><option>resume_alias</option><option>unsubscribe</option></select></label>'
      + '<label>Alias<select id="as-palias"><option value="">any alias</option>' + opts + '</select></label><label>Sender domain<input id="as-pdomain" placeholder="e.g. brightline-ads.com"></label>'
      + '<label>Days (auto-approve)<input id="as-pdays" type="number" min="1" max="90" value="7"></label><button class="btn primary" data-act="add-policy">Add policy</button></div></div></div>';
  }
  function memoryTab() {
    return '<div class="panel as-panel"><h3>Privacy memory</h3><p class="panel-sub">Non-secret text the agent can search with pgvector: incident summaries (masked aliases), service names for matching, and notes you approve. Credentials are refused before anything is embedded.</p>'
      + '<div class="as-ask"><input id="as-mem" maxlength="500" placeholder="Add a note, e.g. I prefer blocking senders over pausing aliases"><button class="btn secondary" data-act="remember">Remember</button></div>'
      + (S.memory.length ? '<table class="as-table"><tbody>' + S.memory.map(function (m) { return '<tr><td><span class="chip gray">' + esc(m.doc_type) + '</span></td><td>' + esc(m.content) + '<br><span class="muted">' + esc(m.model) + ' · ' + esc(new Date(m.created_at).toLocaleString()) + '</span></td><td><button class="btn secondary as-small" data-forget="' + esc(m.id) + '">Delete</button></td></tr>'; }).join('') + '</tbody></table>' : '<div class="empty">Nothing stored.</div>') + '</div>';
  }
  function explainTab() {
    var g = S.graph;
    if (!g) return '<div class="empty">Connect to load the graph description.</div>';
    var byKind = function (k) { return g.tools.filter(function (t) { return t.kind === k; }).map(function (t) { return '<li><b>' + esc(t.name) + '</b> — ' + esc(t.description) + ' <span class="muted">(' + esc(t.callers.join(', ')) + ')</span></li>'; }).join(''); };
    return '<div class="as-grid"><div class="panel as-panel"><h3>Nodes</h3><p class="panel-sub">A node is one step of the workflow. The graph saves a checkpoint after each one, so it can pause for you and resume after a restart.</p><ol class="as-list">'
      + g.nodes.map(function (n) { return '<li><b>' + esc((n.n ? n.n + '. ' : '') + n.label) + '</b> <span class="chip gray">' + esc(n.kind) + '</span><br>' + esc(n.does) + '</li>'; }).join('') + '</ol></div>'
      + '<div class="panel as-panel"><h3>Edges and conditions</h3><p class="panel-sub">An edge is a possible next step; a condition decides which edge is taken.</p><ul class="as-list">'
      + g.edges.filter(function (e) { return e.when; }).map(function (e) { return '<li>' + esc(e.from) + ' → ' + esc(e.to) + ' <span class="muted">when ' + esc(e.when) + '</span></li>'; }).join('') + '</ul>'
      + '<h3>Policy rules</h3><p class="panel-sub">Deterministic checks. No model is involved in deciding whether an action may run.</p><ul class="as-list">' + Object.keys(g.rules).map(function (k) { return '<li><b>' + esc(k) + '</b> ' + esc(g.rules[k]) + '</li>'; }).join('') + '</ul></div>'
      + '<div class="panel as-panel"><h3>Tools</h3><p class="panel-sub">Read tools look; propose tools describe; privileged tools act — and only with an approval grant. There is no general web, shell, browser or password tool.</p>'
      + '<h4>Read</h4><ul class="as-list">' + byKind('read') + '</ul><h4>Propose</h4><ul class="as-list">' + byKind('propose') + '</ul><h4>Privileged</h4><ul class="as-list">' + byKind('privileged') + '</ul>'
      + '<p class="panel-sub">Provider: ' + esc(g.provider.label) + ' · Model: ' + esc(g.model || 'off (rules)') + ' · Embeddings: ' + esc(g.embedder) + '</p></div></div>';
  }

  function draw() {
    var root = document.getElementById('assistant-root');
    if (!root) return;
    var connected = !!(S.token && S.health);
    var body = !connected ? connectPanel() : tabs() + (S.tab === 'assistant' ? assistantTab() : S.tab === 'approvals' ? approvalsTab() : S.tab === 'history' ? historyTab()
      : S.tab === 'policies' ? policiesTab() : S.tab === 'memory' ? memoryTab() : explainTab());
    var prev = document.getElementById('as-input'), keep = prev ? prev.value : '';
    root.innerHTML = '<div class="titlebar"><div><div class="eyebrow">AGENTIC PRIVACY · LANGGRAPH · HUMAN APPROVAL</div><h1>Privacy Assistant</h1><p>Ask in plain words. NEARAuth plans, checks its rules, asks before it acts, then verifies and records what happened.</p></div>'
      + '<div class="as-head">' + modeBanner() + (connected ? '<button class="btn secondary as-small" data-act="disconnect">Disconnect</button>' : '') + '</div></div>'
      + (S.error ? '<div class="notice as-error" role="alert">' + esc(S.error) + '</div>' : '') + (S.busy ? '<div class="as-busy" role="status">Working…</div>' : '') + body;
    var input = document.getElementById('as-input'); if (input && keep) input.value = keep;
    if (S.busy) Array.prototype.forEach.call(root.querySelectorAll('button,input,select,textarea'), function (el) { el.disabled = true; });
    root.setAttribute('aria-busy', S.busy ? 'true' : 'false');
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('#assistant-root [data-act],#assistant-root [data-tab],#assistant-root [data-sug],#assistant-root [data-pick],#assistant-root [data-open],#assistant-root [data-undo],#assistant-root [data-rmpol],#assistant-root [data-forget]');
    if (!t || S.busy) return;
    var d = t.dataset;
    if (d.tab) { S.tab = d.tab; return draw(); }
    if (d.sug) { var inp = document.getElementById('as-input'); if (inp) inp.value = SUGGESTIONS[Number(d.sug)]; return ask(SUGGESTIONS[Number(d.sug)]); }
    if (d.pick) return pick(Number(d.pick));
    if (d.open) return openWorkflow(d.open);
    if (d.undo) return undo(d.undo);
    if (d.rmpol) return removePolicy(d.rmpol);
    if (d.forget) return forget(d.forget);
    ({ connect: connect, disconnect: disconnect, ask: function () { return ask(); }, approve: function () { return decide('approve'); }, decline: function () { return decide('decline'); },
      cancel: cancelWorkflow, sync: syncFromBrowser, 'add-policy': addPolicy, 'delete-history': deleteHistory, remember: remember,
      retention: function () { return saveSetting('retentionDays', Number(document.getElementById('as-ret').value)); } }[d.act] || function () {})();
  });
  document.addEventListener('change', function (e) { var t = e.target; if (t && t.dataset && t.dataset.set && t.closest('#assistant-root')) saveSetting(t.dataset.set, t.checked); });
  document.addEventListener('keydown', function (e) { if (e.target && e.target.id === 'as-input' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ask(); });

  var css = '.as-head{display:flex;gap:10px;align-items:center}.as-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px}.as-tabs button{background:#132033;border:1px solid var(--border);color:#c5d3e8;border-radius:10px;padding:9px 13px;font-weight:700;cursor:pointer}'
    + '.as-tabs button.active{background:#1c4038;color:#7fe6bf;border-color:#2f6d5d}.as-panel{margin-bottom:16px}.as-grid{display:grid;grid-template-columns:minmax(300px,0.9fr) 1.1fr;gap:16px;align-items:start}'
    + '.as-ask{display:flex;gap:10px;margin:8px 0}.as-ask textarea,.as-ask input,.as-form input,.as-form select,.as-inline input{flex:1;background:#0b1322;border:1px solid var(--border);border-radius:10px;color:var(--text);padding:11px;font:inherit}'
    + '.as-ask .btn{width:auto}.as-sugs{display:flex;flex-wrap:wrap;gap:6px}.as-sug{background:#132033;border:1px solid #2a3a53;color:#b8c8df;border-radius:20px;padding:6px 11px;font-size:12px;cursor:pointer}.as-sug:hover{border-color:var(--mint);color:#fff}'
    + '.as-label{font-weight:700}.as-meta{margin-top:10px}.as-small{padding:7px 10px;font-size:12px;width:auto}.as-graph{width:100%;height:auto;max-height:640px}'
    + '.as-edge{fill:none;stroke:#2c3a52;stroke-width:1.3;opacity:.5}.as-edge.hot{opacity:1}.as-edge.hot{stroke:#70e5c2;stroke-width:2.6}'
    + '.as-node rect{fill:#121c2d;stroke:#2f3f58;stroke-width:1.4}.as-node text{fill:#9fb0c8;font-size:11.5px;font-weight:700;text-anchor:middle;font-family:inherit}'
    + '.as-node.interrupt rect{stroke-dasharray:4 3}.as-node.done rect{fill:#173a33;stroke:#70e5c2;animation:as-in .4s both}.as-node.done text{fill:#e9fff7}'
    + '.as-node.waiting rect{fill:#3b2f1b;stroke:#f1bd73;animation:as-pulse 1.4s infinite}.as-node.waiting text{fill:#ffe2b1}'
    + '@keyframes as-in{from{opacity:.2}to{opacity:1}}@keyframes as-pulse{50%{stroke-width:3}}@media (prefers-reduced-motion:reduce){.as-node rect{animation:none!important}}'
    + '.as-approval{border:1px solid #3d5576;background:#0e1a2c;border-radius:13px;padding:16px;margin:12px 0}.as-approval.high{border-color:#a8434d}.as-approval h3{margin:6px 0}'
    + '.as-dl{display:grid;grid-template-columns:110px 1fr;gap:6px 10px;font-size:13px;margin:12px 0}.as-dl dt{color:var(--muted)}.as-dl dd{margin:0}'
    + '.as-actions,.as-cands{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.as-actions .btn,.as-cands .btn{width:auto}.as-cands .btn{white-space:normal;text-align:left}'
    + '.as-table{width:100%;border-collapse:collapse;font-size:12.5px}.as-table td,.as-table th{border-top:1px solid #1f2b3e;padding:8px 6px;vertical-align:top;text-align:left}.as-scroll{overflow-x:auto}'
    + '.as-details summary{cursor:pointer;font-weight:700;margin:10px 0}.as-findings ul,.as-findings ol{margin:6px 0 10px;padding-left:18px;font-size:13px;line-height:1.6}'
    + '.as-pre{background:#0b1322;border:1px solid var(--border);border-radius:10px;padding:10px;color:#7fe6bf;overflow:auto}.as-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;align-items:end;margin-top:12px}'
    + '.as-form label,.as-inline{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--muted)}.as-inline{flex-direction:row;align-items:center;gap:8px;margin:10px 0}.as-inline input{max-width:90px}'
    + '.as-check{display:flex;gap:9px;align-items:flex-start;font-size:13px;margin:10px 0}.as-list{padding-left:18px;line-height:1.6;font-size:13px}.as-error{margin-bottom:12px}.as-busy{color:var(--mint);font-weight:700;margin-bottom:10px}'
    + '@media (max-width:900px){.as-grid{grid-template-columns:1fr}.as-ask{flex-direction:column}.as-dl{grid-template-columns:1fr}}';
  var style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  window.NEARAuthAssistant = {
    show: function () { draw(); if (!S.health) loadAll().then(draw).catch(function () { draw(); }); else if (S.token) refreshSide().then(draw); },
    _state: S,
  };
})();
