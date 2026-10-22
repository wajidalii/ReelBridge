#!/bin/sh
set -e
# Self-migrating API container (SAAS_PLAN.md deployment notes): apply any
# pending Drizzle migrations before accepting traffic. Set RUN_MIGRATIONS=false
# to skip (e.g. when a dedicated release step runs them instead).
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  cd /app/packages/server && node dist/db/migrate.js && cd /app
fi
exec "$@"
