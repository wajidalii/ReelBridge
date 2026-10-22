import pino, { type Logger } from 'pino';

/**
 * One structured logger for API and worker. JSON lines in production (so a
 * log shipper can index `platform`, `postTargetId`, etc. as fields — the
 * PRD's per-platform reliability metrics are computed from these), pretty
 * output in development. Secrets never go through here: tokens are
 * redacted by path as a last line of defence, but callers must still never
 * log a decrypted token deliberately.
 */
const REDACT_PATHS = [
  'accessToken',
  'refreshToken',
  'access_token',
  'refresh_token',
  'password',
  'token',
  '*.accessToken',
  '*.refreshToken',
  '*.access_token',
  '*.refresh_token',
  '*.password',
  'req.headers.cookie',
  'req.headers.authorization',
];

let rootLogger: Logger | undefined;

export function getLogger(): Logger {
  if (!rootLogger) {
    const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'warn' : 'info');
    // An explicit LOG_PRETTY wins; otherwise pretty-print only in development.
    const pretty =
      process.env.LOG_PRETTY !== undefined
        ? process.env.LOG_PRETTY === 'true'
        : process.env.NODE_ENV === 'development';
    rootLogger = pino({
      level,
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      base: { service: process.env.SERVICE_NAME ?? 'reelbridge' },
      ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
    });
  }
  return rootLogger;
}

export function createLogger(bindings: Record<string, unknown>): Logger {
  return getLogger().child(bindings);
}
