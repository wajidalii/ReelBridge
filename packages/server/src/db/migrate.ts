import 'dotenv/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDb, getPool } from './client.js';

async function main() {
  await migrate(getDb(), { migrationsFolder: './src/db/migrations' });
  console.log('Migrations applied successfully.');
  await getPool().end();
}

main().catch((error: unknown) => {
  console.error('Migration failed:', error);
  process.exitCode = 1;
});
