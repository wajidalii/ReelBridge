import 'dotenv/config';
import { db, pool } from './client.js';
import { plans } from './schema.js';

async function main() {
  const existing = await db.select().from(plans).limit(1);
  if (existing.length > 0) {
    console.log('Plans already seeded, skipping.');
    await pool.end();
    return;
  }

  await db.insert(plans).values({
    name: 'Free',
    priceCents: 0,
    maxTargets: 1,
    maxPostsPerMonth: 30,
    isDefault: true,
  });

  console.log('Seeded default plan.');
  await pool.end();
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error);
  process.exitCode = 1;
});
