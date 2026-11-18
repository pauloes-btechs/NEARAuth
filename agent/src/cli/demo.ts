import { loadConfig } from '../config.js';
import { createApi } from '../server.js';
import { AgentService } from '../service.js';

/* One command, no accounts, no paid services: embedded Postgres (PGlite + pgvector), mock provider, rules-only
 * intent parsing (or Ollama if NEARAUTH_LLM=ollama), seeded demo data, and a session token printed for you. */
const cfg = loadConfig({ ...process.env, NEARAUTH_PROVIDER: process.env.NEARAUTH_PROVIDER ?? 'mock' });
const svc = await AgentService.create({ config: cfg });
await svc.seedDemo('demo');
const { token } = await svc.issueSession('demo', 'Demo user', 'demo-dashboard');
createApi(svc, cfg).listen(cfg.port, cfg.host, () => {
  console.log(`\nNEARAuth agent demo running at http://${cfg.host}:${cfg.port}  (${svc.provider.mode === 'simulation' ? 'SIMULATION — mock provider' : 'REAL provider'})`);
  console.log(`Database: ${svc.db.kind}   Model: ${svc.intentModelName ?? 'off (deterministic rules)'}`);
  console.log('\n1. Serve the dashboard:   (from the repo root)  npm run serve   → http://localhost:8080/#assistant');
  console.log(`2. Paste this session token into Privacy Assistant → Connect:\n\n   ${token}\n`);
});
