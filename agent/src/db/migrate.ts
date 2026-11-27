import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ROLE, type Database } from './pool.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Applies versioned SQL migrations in order, each in its own transaction, recording them in schema_migrations. */
export async function migrate(db: Database): Promise<string[]> {
  const c = await db.pool.connect();
  const applied: string[] = [];
  try {
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    // Restricted role the app switches to per transaction. NOLOGIN: it is only ever entered with SET LOCAL ROLE.
    await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN CREATE ROLE ${APP_ROLE} NOLOGIN; END IF; END $$`);
    await c.query(`GRANT ${APP_ROLE} TO CURRENT_USER`).catch(() => {}); // superusers already may SET ROLE
    const done = new Set((await c.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    // Numbered files only: macOS writes ._001_core.sql metadata files on exFAT drives.
    for (const file of readdirSync(DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort()) {
      const version = file.replace(/\.sql$/, '');
      if (done.has(version)) continue;
      await c.query('BEGIN');
      try {
        await c.query(readFileSync(join(DIR, file), 'utf8'));
        await c.query('INSERT INTO schema_migrations(version) VALUES ($1)', [version]);
        await c.query('COMMIT');
        applied.push(version);
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`migration ${version} failed: ${(e as Error).message}`);
      }
    }
    await c.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);
    await c.query(`REVOKE ALL ON schema_migrations FROM ${APP_ROLE}`);
  } finally {
    c.release();
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { loadConfig } = await import('../config.js');
  const { openDatabase } = await import('./pool.js');
  const cfg = loadConfig();
  const db = await openDatabase(cfg);
  const applied = await migrate(db);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'database is up to date');
  await db.close();
}
