import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

function loadDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL environment variable is not set');
  }
  return url;
}

let poolInstance: Pool | undefined;
let dbInstance: NodePgDatabase<typeof schema> | undefined;

/**
 * Lazily constructed so importing this module never fails just because
 * DATABASE_URL isn't set (e.g. code that conditionally needs the DB, or a test
 * file that wants to check reachability and skip gracefully otherwise).
 */
export function getPool(): Pool {
  if (!poolInstance) {
    poolInstance = new Pool({
      connectionString: loadDatabaseUrl(),
      // Bounded so N API/worker replicas can't exhaust Postgres's
      // max_connections between them; idle connections are released so a
      // quiet replica doesn't hold its full share forever.
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl:
        process.env.DATABASE_SSL === 'true'
          ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' }
          : undefined,
    });
  }
  return poolInstance;
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (!dbInstance) {
    dbInstance = drizzle(getPool(), { schema });
  }
  return dbInstance;
}

export type Database = NodePgDatabase<typeof schema>;
