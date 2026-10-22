import { createServer, type Server } from 'node:http';
import { getLogger, getPool, getRedisConnection, metricsRegistry } from '@reelbridge/shared';

/**
 * The worker has no Express app, but still needs to be scraped (issue #39)
 * and probed (container orchestrators need a readiness check that proves
 * Redis and Postgres are reachable from *this* process). A bare http server
 * with three routes is enough.
 */
export function startMetricsServer(): Server {
  const port = Number(process.env.WORKER_METRICS_PORT ?? 4001);
  const log = getLogger().child({ component: 'worker-metrics' });

  const server = createServer(async (req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.url === '/readyz') {
      const checks: Record<string, 'ok' | 'error'> = { database: 'error', redis: 'error' };
      await Promise.all([
        getPool()
          .query('SELECT 1')
          .then(() => {
            checks.database = 'ok';
          })
          .catch(() => {}),
        getRedisConnection()
          .ping()
          .then(() => {
            checks.redis = 'ok';
          })
          .catch(() => {}),
      ]);
      const ready = Object.values(checks).every((value) => value === 'ok');
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: ready ? 'ready' : 'degraded', checks }));
      return;
    }
    if (req.url === '/metrics') {
      const token = process.env.METRICS_BEARER_TOKEN;
      if (token && req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401);
        res.end('unauthorized');
        return;
      }
      res.writeHead(200, { 'Content-Type': metricsRegistry.contentType });
      res.end(await metricsRegistry.metrics());
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(port, () => {
    log.info({ port }, 'worker metrics/health server listening');
  });
  return server;
}
