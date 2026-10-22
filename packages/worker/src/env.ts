// Side-effect module: import first in every entrypoint. Loads `.env` from the
// current working directory and then from each parent directory up to the
// monorepo root, never overriding a value that is already set. Running
// `npm run db:migrate --workspace=...` puts cwd in packages/<pkg>, where a
// plain `dotenv/config` can't see the root `.env` that docker-compose and the
// README tell people to create.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from 'dotenv';

let dir = process.cwd();
for (;;) {
  const candidate = join(dir, '.env');
  if (existsSync(candidate)) {
    config({ path: candidate, override: false });
  }
  if (existsSync(join(dir, 'package-lock.json')) || existsSync(join(dir, '.git'))) break;
  const parent = dirname(dir);
  if (parent === dir) break;
  dir = parent;
}
