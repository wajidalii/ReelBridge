import 'dotenv/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './client.js';

async function main() {
  await migrate(db, { migrationsFolder: './src/db/migrations' });
  console.log('Migrations applied successfully.');
  await pool.end();
}

main().catch((error: unknown) => {
  console.error('Migration failed:', error);
  process.exitCode = 1;
});
