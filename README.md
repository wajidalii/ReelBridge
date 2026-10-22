# ReelBridge

[![CI](https://github.com/wajidalii/ReelBridge/actions/workflows/ci.yml/badge.svg)](https://github.com/wajidalii/ReelBridge/actions/workflows/ci.yml)

bridges your content to every platform

Upload a batch of short-form videos once, fan each clip out to any mix of connected Facebook
Pages, Instagram Business accounts and YouTube channels with per-platform captions, and
schedule the whole batch in one pass. See `planning/` for the PRD, technical design and
design notes.

## Workspace layout

npm workspaces monorepo:

```
packages/
├── shared/                   # Zod schemas, shared TS types, PlatformAdapter interface,
│                              # capability descriptors, token encryption, DB schema, queues,
│                              # structured logging + Prometheus metrics
├── platforms/                # one package per platform, each implementing PlatformAdapter
│   ├── facebook/
│   ├── instagram/
│   └── youtube/
├── server/                   # Express API (auth, connections, targets, media, batches,
│                              # posts, dashboard, billing) + enqueue-only cron sweeps
├── worker/                   # BullMQ worker process — separate deployable from the API
└── client/                   # React (Vite) app
```

See `planning/structure.md` for the rationale behind this layout and `planning/TDD.md` for the
full technical design.

### Getting started

```bash
npm install
npm run lint
npm run typecheck
npm test
```

Each package has its own `build`/`typecheck` script, runnable from the root via
`npm run <script> --workspaces --if-present`, or scoped to one package with
`npm run <script> --workspace=@reelbridge/<name>`.

### Local dev stack

```bash
cp .env.example .env   # fill in ENCRYPTION_KEY / JWT_SECRET at minimum, see comments in the file
docker compose up
```

This brings up Postgres, Redis, MinIO (S3-compatible, dev-only — auto-creates the
`reelbridge-media` bucket), the API (auto-runs migrations on start), and the worker. The
MinIO console is at http://localhost:9001, the API at http://localhost:4000, the worker's
health/metrics server at http://localhost:4001. Run the client with `npm run dev:client`
(http://localhost:5173, proxies `/api` to the API).

Integration tests need Postgres and Redis reachable at `DATABASE_URL`/`REDIS_URL` and
skip themselves otherwise. `npm run db:migrate` applies migrations; `npm run db:seed`
creates the default Free plan.

## Runtime architecture

- **API** (`packages/server`): stateless Express app. Every tenant-scoped route passes
  through `requireAuth` + an `assert*Ownership` check (404 on foreign resources, never 403).
  Cron sweeps in the API only *enqueue* BullMQ jobs; they claim rows atomically so any
  number of API replicas can run them (`CRON_ENABLED=false` to opt a replica out).
- **Worker** (`packages/worker`): consumes the shared `poll-status`, `target-health-check`
  and `topup-schedule` queues, plus one `publish-to-target|<platform>|<account>` queue per
  connected target. The per-target queues are discovered from Postgres every 30s
  (`publishWorkerSupervisor.ts`) and each carries its own BullMQ rate limiter
  (`PLATFORM_RATE_LIMITS` in shared) so one noisy account never starves others. Instagram
  additionally checks Meta's `content_publishing_limit` before each publish and defers the
  job (not fails it) when the account is out of room; YouTube does the same for its daily
  `videos.insert` quota.
- **Scheduling modes**: Facebook and YouTube are *native* (upload now, platform holds the
  publish time, `poll-status` confirms). Instagram has no native scheduling: rows wait in
  `awaiting_app_managed_publish` and a 20-second sweep enqueues them when due — late rows
  are logged as `[app-managed-publish-late]` and counted in
  `reelbridge_app_managed_publish_late_total`.
- **Recurring topup** (`schedule_configs`): per target, a set of daily slot times in an IANA
  timezone plus a cadence. Each run dates that target's unscheduled backlog into the rolling
  window (Instagram capped at 7 days, Facebook at its 29-day API limit, YouTube at 90) and
  records a `schedule_runs` row. "Run now" in Settings uses the same path.

## Security

- Secrets: `ENCRYPTION_KEY` (AES-256-GCM for every stored platform token), `JWT_SECRET`
  (HS256 session + OAuth-state tokens, with pinned `alg`/`iss`/`aud` so one can never be
  replayed as the other), platform app secrets — all distinct, all validated at boot.
- Sessions: 15-minute access JWT + 30-day rotating refresh token in `httpOnly`, `SameSite=Lax`
  cookies; refresh tokens are stored hashed and revoked server-side on logout/password reset.
- CSRF: cookie auth is protected by SameSite plus an `Origin`/`Sec-Fetch-Site` check on
  every mutating request (`middleware/security.ts`). OAuth callbacks are additionally bound
  to the browser that started them via a nonce cookie (`oauthNonce.ts`).
- Headers/limits: `helmet`, per-IP rate limits (auth 20/15min, API 300/min, uploads
  60/hour — tunable via env), 1MB JSON bodies, 500MB per media file, ffprobe content check
  on every upload (extension alone is never trusted), client filenames never touch disk.
- Logging: pino with token/password redaction; never log a decrypted token.
- Email verification and password reset use single-use SHA-256-hashed tokens; the
  forgot-password response is identical whether or not the address exists.

## Observability

Both processes expose Prometheus metrics (optionally behind `METRICS_BEARER_TOKEN`):

| Endpoint                        | Process |
| ------------------------------- | ------- |
| `GET /api/metrics`              | API     |
| `GET /api/health`, `/api/ready` | API     |
| `GET :4001/metrics`             | worker  |
| `GET :4001/healthz`, `/readyz`  | worker  |

Key series, always labelled by `platform` and never pre-blended across platforms:
`reelbridge_publish_attempts_total{outcome}`, `reelbridge_publish_duration_seconds`,
`reelbridge_publish_lateness_seconds` (scheduled-vs-actual for app-managed publishes),
`reelbridge_app_managed_publish_late_total`, `reelbridge_quota_deferrals_total`,
`reelbridge_health_check_results_total{result}`, `reelbridge_post_targets{status}` (sampled
each minute), `reelbridge_sweep_runs_total{sweep,outcome}`. Suggested alerts: any increase
in `..._late_total`; per-platform `failed / (failed+published)` over 1h above 10%; a
`sweep_runs_total{outcome="error"}` increase.

Logs are JSON lines (`LOG_PRETTY=true` for local dev) with `component`, `platform`,
`postTargetId` fields for per-platform failure-rate queries.

## Configuration

All variables are documented in `.env.example`. The ones you'll most likely touch:

- `SIGNUP_MODE=invite` + `SIGNUP_INVITE_CODES` / `SIGNUP_ALLOWED_EMAIL_DOMAINS`: early-access
  gating until Meta App Review (#16) and the YouTube compliance audit (#31) clear.
- `META_APP_REVIEW_APPROVED`, `YOUTUBE_COMPLIANCE_APPROVED`: drive the client's gating copy.
- `EMAIL_PROVIDER=resend` + `RESEND_API_KEY` + `EMAIL_FROM` for real email (`console` logs
  instead; the provider interface in `modules/email/provider.ts` is ~20 lines to swap).
- `PLAN_LIMITS_ENFORCED=true` turns `checkUsageLimit` from a no-op into real enforcement of
  `plans.max_targets` / `max_posts_per_month` (402 with `code: plan_limit_reached`). Wiring
  Stripe (#43) means writing `subscriptions` from a webhook; the call sites already exist.

## Production

`packages/server/Dockerfile` and `packages/worker/Dockerfile` each have a `prod` target
(non-root, `tini`, healthchecks; the API image runs migrations on start unless
`RUN_MIGRATIONS=false`). Run API and worker as separately scalable services against managed
Postgres (`DATABASE_SSL=true` if required), managed Redis and real S3/R2. Set `TRUST_PROXY`
behind a load balancer, `CLIENT_ORIGIN` to the real app origin, and `API_BASE_URL` to the
public https API URL (OAuth redirect URIs derive from it).

## API surface

```
POST       /api/auth/{signup,login,logout,refresh}
GET        /api/auth/me   /api/auth/signup-policy
POST       /api/auth/{verify-email,resend-verification,forgot-password,reset-password}

GET        /api/connections                 DELETE /api/connections/:id
GET        /api/connections/{facebook,google}/{start,callback}
GET        /api/targets   /api/targets/:id   DELETE /api/targets/:id
POST       /api/targets/facebook/manual     POST   /api/targets/:id/revalidate
GET/PUT    /api/targets/:id/schedule/config POST   /api/targets/:id/schedule/trigger

GET/POST   /api/media     GET/DELETE /api/media/:id   GET /api/media/:id/constraints
GET/POST   /api/batches   GET/DELETE /api/batches/:id
POST       /api/batches/:id/items           DELETE /api/batches/:id/items/:itemId
POST       /api/batches/:id/items/:itemId/targets
POST       /api/batches/:id/auto-distribute GET /api/batches/:id/preview  POST /api/batches/:id/publish
GET        /api/posts     POST /api/posts/:id/retry
GET        /api/dashboard /api/billing/usage /api/config
```
