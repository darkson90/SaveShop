import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, PoolClient } from 'pg';
import { env } from './config';

export function createPool(): Pool {
  return new Pool({ connectionString: env('DATABASE_URL'), max: 10 });
}

/** Tabelle comuni a ogni servizio: outbox (eventi in uscita) e inbox (idempotenza dei consumer). */
const COMMON_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name        TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS outbox (
  id            UUID PRIMARY KEY,
  type          TEXT NOT NULL,
  payload       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS outbox_unpublished ON outbox (created_at) WHERE published_at IS NULL;
CREATE TABLE IF NOT EXISTS processed_events (
  event_id      UUID PRIMARY KEY,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

/**
 * Applica in ordine i file .sql della cartella migrations non ancora eseguiti.
 * Un lock consultivo serializza le repliche che partono insieme (es. 2 pod in Kubernetes):
 * la seconda aspetta la prima e poi trova le migrazioni già applicate.
 */
export async function runMigrations(pool: Pool, dir: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('spesa:migrations'))");
    await client.query(COMMON_SQL);
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (done.rowCount) continue;
      try {
        await client.query('BEGIN');
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      console.log(`[db] migrazione applicata: ${file}`);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('spesa:migrations'))").catch(() => undefined);
    client.release();
  }
}

/**
 * Pulizia periodica (ogni ora): eventi già pubblicati dall'outbox dopo 7 giorni, registro dei
 * consumer dopo 30 giorni (oltre la finestra di riconsegna di RabbitMQ), più le query del servizio.
 */
export function startMaintenance(pool: Pool, extra: string[] = [], intervalMs = 60 * 60 * 1000): NodeJS.Timeout {
  const statements = [
    "DELETE FROM outbox WHERE published_at < now() - interval '7 days'",
    "DELETE FROM processed_events WHERE processed_at < now() - interval '30 days'",
    ...extra,
  ];
  const run = async () => {
    for (const sql of statements) {
      await pool.query(sql).catch((err) => console.error(`[db] pulizia fallita (${sql.slice(0, 40)}…):`, err.message));
    }
  };
  setTimeout(run, 60_000).unref(); // primo giro un minuto dopo l'avvio
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return timer;
}

export async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
