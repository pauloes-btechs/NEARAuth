/* Tiny in-memory stand-in for the SimpleLogin API, for end-to-end tests only. Not SimpleLogin's code. */
const http = require('node:http');
function start(port = 9099, key = 'E2E_TEST_KEY') {
  const db = { aliases: {}, contacts: {}, nextAlias: 1, nextContact: 100 };
  db.receive = (aliasId, address) => db.contacts[aliasId].push({ id: db.nextContact++, contact: address, block_forward: false, creation_timestamp: Math.floor(Date.now() / 1000) });
  const server = http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authentication, Content-Type, Accept', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' };
    const send = (status, body) => { res.writeHead(status, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.headers.authentication !== key) return send(401, { error: 'Wrong api key' });
    const u = new URL(req.url, 'http://x'); let m;
    if (req.method === 'POST' && u.pathname === '/api/alias/random/new') {
      const id = db.nextAlias++; const a = { id, email: `e2e.alias${id}@simplelogin.test`, enabled: true };
      db.aliases[id] = a; db.contacts[id] = []; return send(201, a);
    }
    if ((m = /^\/api\/aliases\/(\d+)$/.exec(u.pathname)) && req.method === 'GET') return db.aliases[m[1]] ? send(200, db.aliases[m[1]]) : send(404, {});
    if ((m = /^\/api\/aliases\/(\d+)\/toggle$/.exec(u.pathname))) { const a = db.aliases[m[1]]; a.enabled = !a.enabled; return send(200, { enabled: a.enabled }); }
    if ((m = /^\/api\/aliases\/(\d+)\/contacts$/.exec(u.pathname))) return send(200, { contacts: db.contacts[m[1]] || [] });
    if ((m = /^\/api\/contacts\/(\d+)\/toggle$/.exec(u.pathname))) { const c = Object.values(db.contacts).flat().find((x) => x.id === Number(m[1])); c.block_forward = !c.block_forward; return send(200, { block_forward: c.block_forward }); }
    send(404, {});
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ db, close: () => server.close() })));
}
module.exports = { start };
