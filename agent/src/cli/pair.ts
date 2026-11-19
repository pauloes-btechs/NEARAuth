import { loadConfig } from '../config.js';
import { AgentService } from '../service.js';

/* Issues a session token for a user. Run on the machine that hosts the agent (it needs database access), then paste
 * the token into the dashboard's Privacy Assistant. The token is shown once and stored only as a SHA-256 hash. */
const args = process.argv.slice(2);
const get = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const user = get('user', 'demo');
if (!/^[a-z0-9_-]{2,64}$/.test(user)) { console.error('user must match [a-z0-9_-]{2,64}'); process.exit(1); }
const cfg = loadConfig();
const svc = await AgentService.create({ config: cfg });
if (args.includes('--seed-demo')) console.log('seeded:', await svc.seedDemo(user));
const { token, expiresAt } = await svc.issueSession(user, get('name', user), get('device', 'dashboard'));
console.log(`\nSession token for "${user}" (expires ${expiresAt.toISOString()}):\n\n  ${token}\n\nPaste it into Privacy Assistant → Connect. It is not shown again.`);
await svc.close();
