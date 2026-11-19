import pg from 'pg';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Database {
  kind: 'postgres' | 'pglite';
  url: string;
  pool: pg.Pool;
  /** Runs fn in a transaction as the restricted app role with app.user_id set, so row-level security applies. */
  withUser<T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T>;
  /** System context: pre-auth session lookup and seeding shared documents. */
  withSystem<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export const APP_ROLE = 'nearauth_app';
const USER_ID = /^[a-z0-9_-]{2,64}$/;

function wrap(kind: Database['kind'], url: string, pool: pg.Pool, onClose: () => Promise<void>): Database {
  async function tx<T>(setting: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL ROLE ${APP_ROLE}`);
      await c.query("SELECT set_config('app.user_id', $1, true)", [setting]);
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }
  return {
    kind, url, pool,
    withUser: (userId, fn) => {
      if (!USER_ID.test(userId)) return Promise.reject(new Error('invalid user id'));
      return tx(userId, fn);
    },
    withSystem: (fn) => tx('__system__', fn),
    close: (() => { let p: Promise<void> | null = null; return () => (p ??= (async () => { await pool.end(); await onClose(); })()); })(),
  };
}

/**
 * DATABASE_URL set → regular Postgres (pgvector required).
 * Otherwise → embedded PGlite (Postgres compiled to WASM, with pgvector) exposed on a loopback socket so the same
 * `pg` driver and LangGraph's PostgresSaver work unchanged. PGlite is single-connection, so the pool is capped at 1:
 * every query is serialised, which keeps per-transaction settings (role, app.user_id) correct.
 */
export async function openDatabase(opts: { databaseUrl: string | null; dataDir: string; memory?: boolean }): Promise<Database> {
  if (opts.databaseUrl) {
    const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 10 });
    return wrap('postgres', opts.databaseUrl, pool, async () => {});
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite-pgvector');
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
  let dataDir = 'memory://';
  if (!opts.memory) {
    dataDir = resolve(opts.dataDir, 'pglite');
    mkdirSync(dataDir, { recursive: true });
  }
  const db = await PGlite.create({ dataDir, extensions: { vector } });
  const server = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1' });
  await server.start();
  const conn = server.getServerConn(); // "127.0.0.1:<port>"
  const url = `postgresql://postgres@${conn}/postgres`;
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  return wrap('pglite', url, pool, async () => { await server.stop(); await db.close(); });
}
