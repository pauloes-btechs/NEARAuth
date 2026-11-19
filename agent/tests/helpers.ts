import { loadConfig, type AgentConfig } from '../src/config.js';
import { openDatabase, type Database } from '../src/db/pool.js';
import { MockProvider } from '../src/providers/mock.js';
import { AgentService, type Session } from '../src/service.js';
import type { ProviderAdapter } from '../src/providers/types.js';
import type { IntentModel } from '../src/llm.js';

/* Tests use embedded PGlite by default (no setup) or a real Postgres when TEST_DATABASE_URL is set.
 * No test ever talks to a live provider or model. */

export function testConfig(over: Partial<AgentConfig> = {}): AgentConfig {
  return { ...loadConfig({ NEARAUTH_DATA_DIR: '/tmp/nearauth-agent-tests', NEARAUTH_APPROVAL_KEY: Buffer.alloc(32, 7).toString('base64') } as NodeJS.ProcessEnv), ...over };
}

export async function freshDb(): Promise<Database> {
  return openDatabase({ databaseUrl: process.env.TEST_DATABASE_URL ?? null, dataDir: '/tmp/nearauth-agent-tests', memory: true });
}

let counter = 0;
export const uid = (p = 'u') => `${p}${process.pid}x${++counter}`.toLowerCase();

export async function makeService(opts: { db?: Database; provider?: ProviderAdapter; config?: Partial<AgentConfig>; intentModel?: IntentModel | null } = {}) {
  const provider = opts.provider ?? new MockProvider();
  const svc = await AgentService.create({ config: testConfig(opts.config), db: opts.db ?? await freshDb(), provider, intentModel: opts.intentModel ?? null });
  return { svc, provider: provider as MockProvider };
}

export async function demoUser(svc: AgentService, user = uid()): Promise<{ s: Session; token: string; user: string }> {
  await svc.seedDemo(user);
  const { token } = await svc.issueSession(user, user);
  return { s: await svc.authenticate(token), token, user };
}

type Snap = Awaited<ReturnType<AgentService['snapshot']>>;
export const approval = (w: Snap) => w.interrupt as { type: 'approval'; approvalId: string; actionHash: string; risk: string; warnings: string[]; expiresAt: string };
export const senderId = async (svc: AgentService, s: Session, address: string) =>
  (await svc.listAliases(s)).flatMap((a) => a.senders).find((x) => x.address === address)!.id;
export const aliasIdOf = (user: string, key: 'nova' | 'trail' | 'forum') => `als_${user}_${key}`;
