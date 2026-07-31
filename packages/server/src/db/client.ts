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
    poolInstance = new Pool({ connectionString: loadDatabaseUrl() });
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
