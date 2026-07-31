# ReelBridge

[![CI](https://github.com/wajidalii/ReelBridge/actions/workflows/ci.yml/badge.svg)](https://github.com/wajidalii/ReelBridge/actions/workflows/ci.yml)

bridges your content to every platform

## Workspace layout

npm workspaces monorepo:

```
packages/
├── shared/                   # Zod schemas, shared TS types, PlatformAdapter interface,
│                              # capability descriptors, token encryption utility
├── platforms/                # one package per platform, each implementing PlatformAdapter
│   ├── facebook/
│   ├── instagram/
│   └── youtube/
├── server/                   # Express API (auth, connections, targets, media, batches, dashboard)
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
MinIO console is at http://localhost:9001, the API at http://localhost:4000.

