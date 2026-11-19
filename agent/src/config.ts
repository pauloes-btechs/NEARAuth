import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type ProviderMode = 'mock' | 'simplelogin';
export type LlmMode = 'off' | 'ollama';

export interface AgentConfig {
  host: string;
  port: number;
  databaseUrl: string | null;          // null → embedded PGlite (zero-setup local mode)
  dataDir: string;
  allowedOrigins: string[];
  provider: ProviderMode;
  simpleLoginApiKey: string | null;    // server-side only; never placed in graph state, receipts or logs
  simpleLoginBaseUrl: string;
  llm: LlmMode;
  ollamaUrl: string;
  ollamaModel: string;
  ollamaEmbedModel: string;
  approvalTtlMs: number;
  sessionTtlMs: number;
  approvalKey: Buffer;                 // HMAC key for approvals
}

const isLoopback = (h: string) => ['127.0.0.1', '::1', 'localhost'].includes(h);

/* Reads (or creates once) a random approval-signing key under the data directory, so approvals survive restarts. */
function loadApprovalKey(dataDir: string, env: NodeJS.ProcessEnv): Buffer {
  if (env.NEARAUTH_APPROVAL_KEY) {
    const k = Buffer.from(env.NEARAUTH_APPROVAL_KEY, 'base64');
    if (k.length < 32) throw new Error('NEARAUTH_APPROVAL_KEY must be at least 32 bytes, base64-encoded');
    return k;
  }
  const file = resolve(dataDir, 'approval.key');
  if (existsSync(file)) return Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  mkdirSync(dirname(file), { recursive: true });
  const k = randomBytes(32);
  writeFileSync(file, k.toString('base64'), { mode: 0o600 });
  return k;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const host = env.NEARAUTH_AGENT_HOST || '127.0.0.1';
  const provider = (env.NEARAUTH_PROVIDER || 'mock') as ProviderMode;
  if (!['mock', 'simplelogin'].includes(provider)) throw new Error(`Unknown NEARAUTH_PROVIDER "${provider}"`);
  if (provider === 'simplelogin') {
    if (!env.SIMPLELOGIN_API_KEY) throw new Error('NEARAUTH_PROVIDER=simplelogin needs SIMPLELOGIN_API_KEY');
    // Remediation gate (THREAT_MODEL R1/R2): real-provider execution only from a loopback-bound, single-owner agent.
    if (!isLoopback(host)) throw new Error('Real provider mode is only allowed when the agent binds to a loopback address');
  }
  const llm = (env.NEARAUTH_LLM || 'off') as LlmMode;
  if (!['off', 'ollama'].includes(llm)) throw new Error(`Unknown NEARAUTH_LLM "${llm}"`);
  const dataDir = resolve(env.NEARAUTH_DATA_DIR || '.data');
  return {
    host,
    port: Number(env.NEARAUTH_AGENT_PORT || 8787),
    databaseUrl: env.DATABASE_URL || null,
    dataDir,
    allowedOrigins: (env.NEARAUTH_ALLOWED_ORIGINS || 'https://pauloes-btechs.github.io,http://localhost:8080,http://127.0.0.1:8080')
      .split(',').map((s) => s.trim()).filter(Boolean),
    provider,
    simpleLoginApiKey: env.SIMPLELOGIN_API_KEY || null,
    simpleLoginBaseUrl: env.SIMPLELOGIN_BASE_URL || 'https://app.simplelogin.io',
    llm,
    ollamaUrl: env.OLLAMA_URL || 'http://127.0.0.1:11434',
    ollamaModel: env.OLLAMA_MODEL || 'llama3.2:3b',
    ollamaEmbedModel: env.OLLAMA_EMBED_MODEL || 'nomic-embed-text',
    approvalTtlMs: Number(env.NEARAUTH_APPROVAL_TTL_MS || 10 * 60 * 1000),
    sessionTtlMs: Number(env.NEARAUTH_SESSION_TTL_MS || 12 * 60 * 60 * 1000),
    approvalKey: loadApprovalKey(dataDir, env),
  };
}
