import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

function loadDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL environment variable is not set');
  }
  return url;
}

export const pool = new Pool({ connectionString: loadDatabaseUrl() });

export const db = drizzle(pool, { schema });

export type Database = typeof db;
